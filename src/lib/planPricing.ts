import { Plan } from "../models/Plan.js";
import { PLAN_CATALOG, getPlanCatalogEntry, type PlanCatalogEntry } from "../plans.js";

export type ResolvedPlan = PlanCatalogEntry & {
  priceMonthly: number;
  priceYearly: number;
};

/** Every catalogue plan, with its current price — 0 until an admin sets one. */
export async function listResolvedPlans(): Promise<ResolvedPlan[]> {
  const rows = await Plan.find({ slug: { $in: PLAN_CATALOG.map((p) => p.slug) } });
  const priceBySlug = new Map(rows.map((r) => [r.slug as string, r]));

  return PLAN_CATALOG.slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((entry) => {
      const row = priceBySlug.get(entry.slug);
      return {
        ...entry,
        priceMonthly: (row?.priceMonthly as number) ?? 0,
        priceYearly: (row?.priceYearly as number) ?? 0,
      };
    });
}

/** One catalogue plan with its current price, or null if the slug isn't a real plan. */
export async function getResolvedPlan(slug: string): Promise<ResolvedPlan | null> {
  const entry = getPlanCatalogEntry(slug);
  if (!entry) return null;
  const row = await Plan.findOne({ slug });
  return {
    ...entry,
    priceMonthly: (row?.priceMonthly as number) ?? 0,
    priceYearly: (row?.priceYearly as number) ?? 0,
  };
}
