import type { Types } from "mongoose";
import { Subscription } from "../billing/models/Subscription.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { User } from "../identity/models/User.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { cursorFilter, iso, isLapsed, nextCursor, pageSize } from "./present.js";

export const SUBSCRIPTION_FILTERS = ["active", "expired", "past_due"] as const;
type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number];

const PAST_DUE = ["pending", "halted"];

type SubscriptionRow = {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  planSlug: string;
  cycle?: string;
  status?: string;
  currentPeriodEnd?: Date | null;
  autoRenew?: boolean;
  renewalStatus?: string | null;
  createdAt: Date;
};

export type PlatformSubscription = {
  id: string;
  subjectType: "workspace";
  subjectId: string;
  subjectLabel: string;
  ownerId: string;
  ownerEmail: string;
  planKey: string;
  planName: string;
  cycle: "monthly" | "yearly" | null;
  status: "active" | "expired" | "past_due";
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  renewalStatus: string | null;
  createdAt: string;
};

const FIELDS = "workspaceId userId planSlug cycle status currentPeriodEnd autoRenew renewalStatus createdAt";

function statusOf(row: SubscriptionRow): PlatformSubscription["status"] {
  if (isLapsed(row)) return "expired";
  return PAST_DUE.includes(row.renewalStatus ?? "") ? "past_due" : "active";
}

function statusFilter(status: SubscriptionFilter): Record<string, unknown> {
  const now = new Date();
  if (status === "expired") return { $or: [{ status: "expired" }, { currentPeriodEnd: { $lt: now } }] };
  const live = { status: { $ne: "expired" }, $or: [{ currentPeriodEnd: null }, { currentPeriodEnd: { $gte: now } }] };
  return status === "past_due" ? { ...live, renewalStatus: { $in: PAST_DUE } } : live;
}

async function present(rows: SubscriptionRow[]): Promise<PlatformSubscription[]> {
  const workspaceIds = rows.map((row) => row.workspaceId);
  const userIds = [...new Set(rows.map((row) => String(row.userId)))];
  const [workspaces, users] = await Promise.all([
    workspaceIds.length ? Workspace.find({ _id: { $in: workspaceIds } }).select("name").lean() : [],
    userIds.length ? User.find({ _id: { $in: userIds } }).select("email").lean() : [],
  ]);
  const names = new Map(workspaces.map((workspace) => [String(workspace._id), String(workspace.name)]));
  const emails = new Map(users.map((user) => [String(user._id), String(user.email)]));

  return rows.map((row) => ({
    id: String(row._id),
    subjectType: "workspace",
    subjectId: String(row.workspaceId),
    subjectLabel: names.get(String(row.workspaceId)) ?? "Deleted workspace",
    ownerId: String(row.userId),
    ownerEmail: emails.get(String(row.userId)) ?? "",
    planKey: row.planSlug,
    planName: getPlanCatalogEntry(row.planSlug)?.name ?? row.planSlug,
    cycle: row.cycle === "monthly" || row.cycle === "yearly" ? row.cycle : null,
    status: statusOf(row),
    currentPeriodEnd: iso(row.currentPeriodEnd),
    autoRenew: Boolean(row.autoRenew),
    renewalStatus: row.renewalStatus ?? null,
    createdAt: iso(row.createdAt) as string,
  }));
}

export async function listPlatformSubscriptions(query: { status?: unknown; plan?: unknown; cursor?: unknown; limit?: unknown }) {
  const limit = pageSize(query.limit);
  const filter: Record<string, unknown> = { ...cursorFilter(query.cursor) };
  if (SUBSCRIPTION_FILTERS.includes(query.status as SubscriptionFilter)) Object.assign(filter, statusFilter(query.status as SubscriptionFilter));
  if (typeof query.plan === "string" && getPlanCatalogEntry(query.plan)) filter.planSlug = query.plan;

  const rows = await Subscription.find(filter).sort({ _id: -1 }).limit(limit + 1).select(FIELDS).lean<SubscriptionRow[]>();
  return { items: await present(rows.slice(0, limit)), nextCursor: nextCursor(rows, limit) };
}

export async function subscriptionsForOwner(userId: string) {
  const rows = await Subscription.find({ userId }).sort({ _id: -1 }).limit(50).select(FIELDS).lean<SubscriptionRow[]>();
  return present(rows);
}
