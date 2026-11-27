import { Types } from "mongoose";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 50;

export type PlanSummary = {
  key: string;
  name: string;
  status: "active" | "expired" | "lifetime";
  expiresAt: string | null;
};

type SubscriptionLike = { planSlug?: unknown; status?: unknown; currentPeriodEnd?: Date | null };

export function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function isLapsed(sub: SubscriptionLike, now = Date.now()): boolean {
  if (sub.status === "expired") return true;
  return Boolean(sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() < now);
}

export function planSummary(sub: SubscriptionLike | undefined): PlanSummary | null {
  if (!sub?.planSlug) return null;
  const entry = getPlanCatalogEntry(String(sub.planSlug));
  if (!entry) return null;
  return {
    key: entry.slug,
    name: entry.name,
    status: isLapsed(sub) ? "expired" : "active",
    expiresAt: iso(sub.currentPeriodEnd),
  };
}

export function bestPlan(subs: SubscriptionLike[]): PlanSummary | null {
  let best: { plan: PlanSummary; rank: number } | null = null;
  for (const sub of subs) {
    const plan = planSummary(sub);
    const entry = plan ? getPlanCatalogEntry(plan.key) : undefined;
    if (!plan || !entry) continue;
    const rank = (plan.status === "active" ? 1000 : 0) + entry.sortOrder;
    if (!best || rank > best.rank) best = { plan, rank };
  }
  return best?.plan ?? null;
}

export function pageSize(value: unknown): number {
  const size = Number(value);
  return Number.isInteger(size) && size > 0 ? Math.min(size, MAX_PAGE) : DEFAULT_PAGE;
}

export function cursorFilter(cursor: unknown): Record<string, unknown> {
  return typeof cursor === "string" && Types.ObjectId.isValid(cursor) ? { _id: { $lt: new Types.ObjectId(cursor) } } : {};
}

export function nextCursor<T extends { _id: unknown }>(rows: T[], limit: number): string | null {
  return rows.length > limit ? String(rows[limit - 1]?._id ?? "") || null : null;
}

export function idRange(from: Date, to: Date) {
  return {
    $gte: Types.ObjectId.createFromTime(Math.floor(from.getTime() / 1000)),
    $lt: Types.ObjectId.createFromTime(Math.floor(to.getTime() / 1000)),
  };
}
