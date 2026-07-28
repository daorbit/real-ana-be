import { Plan } from "../models/Plan.js";
import { PLAN_CATALOG, getPlanCatalogEntry, type PlanCatalogEntry } from "../plans.js";
import { CURRENCIES, type Currency } from "./currency.js";

type PriceMap = Partial<Record<Currency, number>>;

export type ResolvedPlan = PlanCatalogEntry & {
  /** All configured prices, per currency — the client picks its own. */
  priceMonthly: Record<Currency, number>;
  priceYearly: Record<Currency, number>;
};

function fillPrices(row: PriceMap | undefined): Record<Currency, number> {
  return Object.fromEntries(CURRENCIES.map((c) => [c, row?.[c] ?? 0])) as Record<Currency, number>;
}

/** Every catalogue plan, with its current prices — 0 until an admin sets one. */
export async function listResolvedPlans(): Promise<ResolvedPlan[]> {
  const rows = await Plan.find({ slug: { $in: PLAN_CATALOG.map((p) => p.slug) } });
  const priceBySlug = new Map(rows.map((r) => [r.slug as string, r]));

  return PLAN_CATALOG.slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((entry) => {
      const row = priceBySlug.get(entry.slug);
      return {
        ...entry,
        priceMonthly: fillPrices(asPriceMap(row?.priceMonthly)),
        priceYearly: fillPrices(asPriceMap(row?.priceYearly)),
      };
    });
}

/** One catalogue plan with its current prices, or null if the slug isn't a real plan. */
export async function getResolvedPlan(slug: string): Promise<ResolvedPlan | null> {
  const entry = getPlanCatalogEntry(slug);
  if (!entry) return null;
  const row = await Plan.findOne({ slug });
  return {
    ...entry,
    priceMonthly: fillPrices(asPriceMap(row?.priceMonthly)),
    priceYearly: fillPrices(asPriceMap(row?.priceYearly)),
  };
}

/** A price subdocument (or a plain object, when read via `.lean()`) as a plain price map. */
function asPriceMap(value: unknown): PriceMap | undefined {
  if (!value) return undefined;
  const obj = value as { toObject?: () => PriceMap };
  return typeof obj.toObject === "function" ? obj.toObject() : (value as PriceMap);
}
