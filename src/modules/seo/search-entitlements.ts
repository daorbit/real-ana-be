import { currentPlan } from "../billing/quota.service.js";
import { SEARCH_INSIGHTS_LIMITED_ROWS, type SearchInsightsAccess } from "../billing/plans.catalog.js";
import type { PlanLimitCode, PlanLimitInfo } from "../../http/plan-limit.js";

export type SearchEntitlement = {
  planName: string;
  maxDays: number;
  rowLimit: number | null;
  insights: SearchInsightsAccess;
  insightRows: number | undefined;
  pageViews: boolean;
  inspectionQuota: number;
};

export class SearchPlanDenied extends Error {
  constructor(
    message: string,
    readonly limit: PlanLimitInfo,
    readonly code: PlanLimitCode = "plan_required",
  ) {
    super(message);
  }
}

export async function searchEntitlement(workspaceId: string): Promise<SearchEntitlement | null> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return null;
  return {
    planName: plan.name,
    maxDays: plan.searchMaxDays,
    rowLimit: plan.searchRowLimit,
    insights: plan.searchInsights,
    insightRows: plan.searchInsights === "limited" ? SEARCH_INSIGHTS_LIMITED_ROWS : undefined,
    pageViews: plan.searchPageViews,
    inspectionQuota: plan.monthlyInspectionQuota,
  };
}

function historyLabel(days: number) {
  return days >= 60 ? `${Math.round(days / 30)} months` : `${days} days`;
}

export function ensureSearchDays(ent: SearchEntitlement, days: number) {
  if (days <= ent.maxDays) return;
  throw new SearchPlanDenied(
    `The ${ent.planName} plan includes the last ${historyLabel(ent.maxDays)} of Google Search data. Upgrade to see ${historyLabel(days)}.`,
    { kind: "search_range", label: "Search history", plan: ent.planName },
  );
}

export function ensureSearchInsights(ent: SearchEntitlement) {
  if (ent.insights !== "none") return;
  throw new SearchPlanDenied(
    `Search insights are included from the Starter plan. Upgrade to see what to fix first.`,
    { kind: "search_insights", label: "Search insights", plan: ent.planName },
  );
}
