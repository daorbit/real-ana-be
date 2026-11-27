import { Types } from "mongoose";
import { adminUserOverview } from "../admin/user-overview.service.js";
import { Subscription } from "../billing/models/Subscription.js";
import { Session } from "../identity/models/Session.js";
import { User } from "../identity/models/User.js";
import { escapeRegex } from "../../shared/utils/escape-regex.js";
import { listPlatformPayments } from "./payments.service.js";
import { bestPlan, cursorFilter, iso, nextCursor, pageSize, type PlanSummary } from "./present.js";
import { subscriptionsForOwner } from "./subscriptions.service.js";

export type PlatformUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  status: "active" | "suspended";
  role: string;
  createdAt: string;
  lastActiveAt: string | null;
  plan: PlanSummary | null;
  avatarUrl: string | null;
};

type UserRow = { _id: Types.ObjectId; email: string; name: string; role: string; status?: string; avatarUrl?: string; createdAt: Date };

function accountStatus(value: unknown): PlatformUser["status"] {
  return value === "suspended" ? "suspended" : "active";
}

async function lastActiveByUser(ids: Types.ObjectId[]) {
  if (!ids.length) return new Map<string, Date>();
  const rows = await Session.aggregate<{ _id: Types.ObjectId; last: Date }>([
    { $match: { userId: { $in: ids } } },
    { $group: { _id: "$userId", last: { $max: "$lastSeenAt" } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.last]));
}

async function plansByOwner(ids: Types.ObjectId[]) {
  if (!ids.length) return new Map<string, PlanSummary | null>();
  const subs = await Subscription.find({ userId: { $in: ids } }).select("userId planSlug status currentPeriodEnd").lean();
  const grouped = new Map<string, typeof subs>();
  for (const sub of subs) grouped.set(String(sub.userId), [...(grouped.get(String(sub.userId)) ?? []), sub]);
  return new Map([...grouped].map(([owner, rows]) => [owner, bestPlan(rows)]));
}

async function present(rows: UserRow[]): Promise<PlatformUser[]> {
  const ids = rows.map((row) => row._id);
  const [lastActive, plans] = await Promise.all([lastActiveByUser(ids), plansByOwner(ids)]);
  return rows.map((row) => ({
    id: String(row._id),
    email: row.email,
    name: row.name,
    emailVerified: true,
    status: accountStatus(row.status),
    role: row.role,
    createdAt: iso(row.createdAt) as string,
    lastActiveAt: iso(lastActive.get(String(row._id)) ?? null),
    plan: plans.get(String(row._id)) ?? null,
    avatarUrl: row.avatarUrl || null,
  }));
}

export async function listPlatformUsers(query: { q?: unknown; cursor?: unknown; limit?: unknown }) {
  const limit = pageSize(query.limit);
  const filter: Record<string, unknown> = { ...cursorFilter(query.cursor) };
  const term = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  if (term) {
    const pattern = { $regex: escapeRegex(term), $options: "i" };
    filter.$or = [{ email: pattern }, { name: pattern }, ...(Types.ObjectId.isValid(term) ? [{ _id: new Types.ObjectId(term) }] : [])];
  }

  const rows = await User.find(filter).sort({ _id: -1 }).limit(limit + 1).select("email name role status avatarUrl createdAt").lean<UserRow[]>();
  return { items: await present(rows.slice(0, limit)), nextCursor: nextCursor(rows, limit) };
}

export async function platformUserDetail(userId: string) {
  if (!Types.ObjectId.isValid(userId)) return null;
  const [overview, subscriptions, payments, lastActive, account] = await Promise.all([
    adminUserOverview(userId),
    subscriptionsForOwner(userId),
    listPlatformPayments({ userId, limit: 50 }),
    lastActiveByUser([new Types.ObjectId(userId)]),
    User.findById(userId).select("status statusReason audience avatarUrl").lean(),
  ]);
  if (!overview) return null;
  const { user, totals, workspaces, signIns } = overview;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: true,
      status: accountStatus(account?.status),
      role: user.role,
      createdAt: iso(user.createdAt) as string,
      lastActiveAt: iso(lastActive.get(user.id) ?? null),
      avatarUrl: account?.avatarUrl || null,
      audience: account?.audience === "internal" ? "internal" : "external",
      plan: bestPlan(subscriptions.map((sub) => ({ planSlug: sub.planKey, status: sub.status === "expired" ? "expired" : "active", currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null }))),
    },
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      plan: workspace.plan
        ? { key: workspace.plan.slug, name: workspace.plan.name, status: workspace.plan.expired ? ("expired" as const) : ("active" as const), expiresAt: iso(workspace.plan.renewsAt) }
        : null,
      apps: workspace.apps,
      members: workspace.members,
      sites: workspace.sites.length,
      createdAt: iso(workspace.createdAt) as string,
    })),
    subscriptions,
    payments: payments.items,
    facts: [
      { label: "Account type", value: account?.audience === "internal" ? "Internal" : "External" },
      ...(account?.status === "suspended" ? [{ label: "Suspended because", value: account.statusReason || "No reason given" }] : []),
      { label: "Two-factor authentication", value: user.totpEnabled ? "On" : "Off" },
      { label: "Screen lock", value: user.screenLockEnabled ? "On" : "Off" },
      { label: "Workspaces", value: `${totals.owned} owned, ${totals.shared} shared` },
      { label: "Sites", value: String(totals.sites) },
      { label: "Events, last 30 days", value: totals.events30d.toLocaleString("en-IN") },
      { label: "Last sign-in", value: signIns[0] ? `${iso(signIns[0].at)} ${[signIns[0].browser, signIns[0].os, signIns[0].location].filter(Boolean).join(", ")}`.trim() : "Unknown" },
      { label: "Heard about us from", value: user.referralSources.join(", ") || "Not given" },
    ],
  };
}
