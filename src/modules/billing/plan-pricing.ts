import { Plan } from "./models/Plan.js";
import { PLAN_CATALOG, getPlanCatalogEntry, type PlanCatalogEntry } from "./plans.catalog.js";
import {
  ORBIT_PLAN_CATALOG,
  getOrbitPlanEntry,
  type OrbitPlanEntry,
} from "../orbit/orbit-plans.catalog.js";
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

export type ResolvedOrbitPlan = OrbitPlanEntry & {
  priceMonthly: Record<Currency, number>;
  priceYearly: Record<Currency, number>;
};

/**
 * Every Orbit tier, with its current prices.
 *
 * Prices share the `Plan` collection with the analytics tiers rather than
 * getting one of their own: that collection is keyed by slug and holds nothing
 * but prices, and the two catalogues' slugs cannot collide (`orbit-` prefix).
 * A separate collection would need its own admin screen and its own FX reprice
 * job to stay correct, for no gain.
 */
export async function listResolvedOrbitPlans(): Promise<ResolvedOrbitPlan[]> {
  const rows = await Plan.find({ slug: { $in: ORBIT_PLAN_CATALOG.map((p) => p.slug) } });
  const priceBySlug = new Map(rows.map((r) => [r.slug as string, r]));

  return ORBIT_PLAN_CATALOG.slice()
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

/** One Orbit tier with its prices, or null if the slug isn't one. */
export async function getResolvedOrbitPlan(slug: string): Promise<ResolvedOrbitPlan | null> {
  const entry = getOrbitPlanEntry(slug);
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
