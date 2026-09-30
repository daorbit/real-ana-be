import { Subscription } from "./models/Subscription.js";
import { UsageMonth } from "./models/UsageMonth.js";
import { PlanPurchase } from "./models/PlanPurchase.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";
import { resolveOrbitPlan } from "../orbit/orbit-plans.catalog.js";
import { nextUsageReset, rollUsageMonth, usageMonthKey } from "./usage-month.js";

const HISTORY_MONTHS = 12;
const PLAN_EVENTS = 24;

type MonthTotals = {
  events: number;
  audits: number;
  crawls: number;
  inspections: number;
  formSubmissions: number;
  orbit: number;
};

export type UsageHistoryMonth = MonthTotals & {
  month: string;
  current: boolean;
  plan: { slug: string; name: string };
  eventQuota: number;
};

export type UsagePlanEvent = {
  ladder: "analytics" | "orbit";
  planSlug: string;
  planName: string;
  cycle: string;
  purchasedAt: string | null;
};

export type UsageHistory = {
  resetsAt: string;
  months: UsageHistoryMonth[];
  plans: UsagePlanEvent[];
};

function planOf(slug: string) {
  const entry = getPlanCatalogEntry(slug) ?? getPlanCatalogEntry("free");
  return {
    plan: { slug: entry?.slug ?? slug, name: entry?.name ?? slug },
    eventQuota: entry?.monthlyEventQuota ?? 0,
  };
}

function totalsOf(source: Record<string, unknown>, keys: Record<keyof MonthTotals, string>): MonthTotals {
  const read = (key: string) => Number(source[key] ?? 0);
  return {
    events: read(keys.events),
    audits: read(keys.audits),
    crawls: read(keys.crawls),
    inspections: read(keys.inspections),
    formSubmissions: read(keys.formSubmissions),
    orbit: read(keys.orbit),
  };
}

const LIVE_KEYS: Record<keyof MonthTotals, string> = {
  events: "eventsUsed",
  audits: "auditsUsed",
  crawls: "crawlsUsed",
  inspections: "inspectionsUsed",
  formSubmissions: "formSubmissionsUsed",
  orbit: "orbitUsed",
};

const ARCHIVED_KEYS: Record<keyof MonthTotals, string> = {
  events: "events",
  audits: "audits",
  crawls: "crawls",
  inspections: "inspections",
  formSubmissions: "formSubmissions",
  orbit: "orbit",
};

export async function usageHistory(workspaceId: string): Promise<UsageHistory | null> {
  await rollUsageMonth(workspaceId);

  const [sub, archived, purchases] = await Promise.all([
    Subscription.findOne({ workspaceId }),
    UsageMonth.find({ workspaceId }).sort({ month: -1 }).limit(HISTORY_MONTHS - 1).lean(),
    PlanPurchase.find({ workspaceId, status: "paid" })
      .sort({ invoicedAt: -1 })
      .limit(PLAN_EVENTS)
      .select("planSlug ladder cycle invoicedAt")
      .lean(),
  ]);
  if (!sub) return null;

  const expired = !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() < Date.now();
  const current: UsageHistoryMonth = {
    month: (sub.get("usageMonth") as string | null) ?? usageMonthKey(),
    current: true,
    ...planOf(expired ? "free" : (sub.planSlug as string)),
    ...totalsOf(sub.toObject() as Record<string, unknown>, LIVE_KEYS),
  };

  const past: UsageHistoryMonth[] = archived.map((row) => ({
    month: row.month,
    current: false,
    ...planOf(row.planSlug || "free"),
    ...totalsOf(row as Record<string, unknown>, ARCHIVED_KEYS),
  }));

  const plans: UsagePlanEvent[] = purchases.map((p) => {
    const ladder = p.ladder === "orbit" ? "orbit" : "analytics";
    return {
      ladder,
      planSlug: p.planSlug,
      planName: ladder === "orbit" ? resolveOrbitPlan(p.planSlug).name : planOf(p.planSlug).plan.name,
      cycle: p.cycle,
      purchasedAt: p.invoicedAt ? new Date(p.invoicedAt).toISOString() : null,
    };
  });

  return {
    resetsAt: nextUsageReset().toISOString(),
    months: [current, ...past],
    plans,
  };
}
