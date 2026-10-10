import { Types } from "mongoose";
import { AuditLog } from "./models/AuditLog.js";
import { AUDIT_ACTIONS, actionsIn, type AuditAction, type AuditCategory } from "./actions.js";
import { User } from "../identity/models/User.js";
import { describeClient, sessionInfoFor } from "../../shared/utils/session-info.js";
import { captureServerError } from "../../infra/monitoring/sentry.js";
import type { AuthedRequest } from "../../http/middleware/auth.js";

export type AuditTarget = { kind: string; id?: string; label?: string };

export type AuditInput = {
  action: AuditAction;
  workspaceId?: string | null;
  actorId?: string | null;
  impersonatorId?: string | null;
  target?: AuditTarget;
  meta?: Record<string, unknown>;
};

type ForeignAuditInput = AuditInput & {
  source: "forms";
  ip: string;
  userAgent: string;
};

const META_KEYS = 12;
const META_STRING = 200;
const LABEL_LENGTH = 160;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function cleanMeta(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  if (!meta) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(meta).slice(0, META_KEYS)) {
    if (typeof value === "string") out[key] = value.slice(0, META_STRING);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function cleanTarget(target: AuditTarget | undefined) {
  if (!target) return { kind: "", id: "", label: "" };
  return {
    kind: target.kind.slice(0, 40),
    id: (target.id ?? "").slice(0, 64),
    label: (target.label ?? "").slice(0, LABEL_LENGTH),
  };
}

function objectIdOrNull(value: string | null | undefined) {
  return value && Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

function rowFor(input: AuditInput, client: { ip: string; location: string; browser: string; os: string }) {
  return {
    workspaceId: objectIdOrNull(input.workspaceId),
    actorId: objectIdOrNull(input.actorId),
    action: input.action,
    target: cleanTarget(input.target),
    meta: cleanMeta(input.meta),
    ip: client.ip,
    location: client.location,
    browser: client.browser,
    os: client.os,
  };
}

export async function recordAudit(req: AuthedRequest, input: AuditInput): Promise<void> {
  if (req.isDemo) return;
  if (req.res) req.res.locals.audited = true;
  try {
    await AuditLog.create({
      ...rowFor({ ...input, actorId: input.actorId ?? req.userId ?? null }, sessionInfoFor(req)),
      impersonatorId: objectIdOrNull(input.impersonatorId ?? req.impersonatorId),
      source: "dashboard",
    });
  } catch (e) {
    await captureServerError(e, { method: req.method, path: req.originalUrl, userId: req.userId });
  }
}

export async function recordForeignAudit(input: ForeignAuditInput): Promise<void> {
  await AuditLog.create({
    ...rowFor(input, describeClient(input.ip, input.userAgent)),
    source: input.source,
  });
}

type PageOptions = {
  cursor?: Date;
  limit?: number;
};

type WorkspacePageOptions = PageOptions & {
  since: Date;
  category?: AuditCategory;
  actorId?: string;
};

type AuditRow = {
  _id: Types.ObjectId;
  actorId?: Types.ObjectId | null;
  impersonatorId?: Types.ObjectId | null;
  action: string;
  target?: { kind?: string; id?: string; label?: string };
  meta?: Record<string, unknown>;
  source?: string;
  ip?: string;
  location?: string;
  browser?: string;
  os?: string;
  createdAt: Date;
};

const ROW_FIELDS = "actorId impersonatorId action target meta source ip location browser os createdAt";

function pageLimit(limit: number | undefined) {
  return Math.min(MAX_LIMIT, Math.max(1, limit || DEFAULT_LIMIT));
}

async function presentPage(rows: AuditRow[], limit: number) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const actorIds = [...new Set(page.flatMap((r) => (r.actorId ? [String(r.actorId)] : [])))];
  const actors = actorIds.length
    ? await User.find({ _id: { $in: actorIds } }).select("name email avatarUrl").lean()
    : [];
  const actorById = new Map(actors.map((u) => [String(u._id), u]));

  return {
    items: page.map((r) => {
      const actor = r.actorId ? actorById.get(String(r.actorId)) : undefined;
      return {
        id: String(r._id),
        action: r.action,
        category: AUDIT_ACTIONS[r.action as AuditAction] ?? "workspace",
        createdAt: r.createdAt,
        actor: r.actorId
          ? {
              id: String(r.actorId),
              name: (actor?.name as string) ?? "",
              email: (actor?.email as string) ?? "",
              avatarUrl: (actor?.avatarUrl as string) ?? "",
              deleted: !actor,
            }
          : null,
        viaSupport: Boolean(r.impersonatorId),
        target: {
          kind: r.target?.kind ?? "",
          id: r.target?.id ?? "",
          label: r.target?.label ?? "",
        },
        meta: r.meta ?? {},
        source: r.source ?? "dashboard",
        ip: r.ip ?? "",
        location: r.location ?? "",
        browser: r.browser ?? "",
        os: r.os ?? "",
      };
    }),
    nextCursor: hasMore ? page[page.length - 1].createdAt : null,
  };
}

export async function workspaceAuditPage(workspaceId: string, options: WorkspacePageOptions) {
  const limit = pageLimit(options.limit);
  const createdAt: Record<string, Date> = { $gte: options.since };
  if (options.cursor) createdAt.$lt = options.cursor;

  const filter: Record<string, unknown> = { workspaceId: new Types.ObjectId(workspaceId), createdAt };
  if (options.category) filter.action = { $in: actionsIn(options.category) };
  if (options.actorId && Types.ObjectId.isValid(options.actorId)) filter.actorId = new Types.ObjectId(options.actorId);

  const rows = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .select(ROW_FIELDS)
    .lean<AuditRow[]>();

  return presentPage(rows, limit);
}

export async function workspaceAuditSummary(workspaceId: string, since: Date) {
  const groups = await AuditLog.aggregate<{ _id: string; count: number; actors: Types.ObjectId[]; lastAt: Date }>([
    { $match: { workspaceId: new Types.ObjectId(workspaceId), createdAt: { $gte: since } } },
    { $group: { _id: "$action", count: { $sum: 1 }, actors: { $addToSet: "$actorId" }, lastAt: { $max: "$createdAt" } } },
  ]);

  const byCategory: Record<string, number> = {};
  const actors = new Set<string>();
  let total = 0;
  let lastAt: Date | null = null;

  for (const group of groups) {
    const category = AUDIT_ACTIONS[group._id as AuditAction] ?? "workspace";
    byCategory[category] = (byCategory[category] ?? 0) + group.count;
    total += group.count;
    for (const actor of group.actors) if (actor) actors.add(String(actor));
    if (!lastAt || group.lastAt > lastAt) lastAt = group.lastAt;
  }

  return { total, people: actors.size, lastAt, byCategory };
}

export async function accountAuditPage(userId: string, options: PageOptions) {
  const limit = pageLimit(options.limit);
  const filter: Record<string, unknown> = { actorId: new Types.ObjectId(userId), workspaceId: null };
  if (options.cursor) filter.createdAt = { $lt: options.cursor };

  const rows = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .select(ROW_FIELDS)
    .lean<AuditRow[]>();

  return presentPage(rows, limit);
}

export function parseCursor(raw: unknown): Date | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  const cursor = new Date(String(raw));
  return Number.isNaN(cursor.getTime()) ? null : cursor;
}
