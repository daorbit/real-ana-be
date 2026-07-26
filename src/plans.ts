/**
 * The fixed catalogue of subscription tiers.
 *
 * Everything about a plan except its price is decided in code, not the
 * database — quotas and workspace/site limits are the kind of thing that
 * should never silently drift because someone fat-fingered an admin form.
 * Only price is left editable at runtime (see `models/Plan.ts`), because
 * that's the one thing that legitimately changes without a deploy.
 *
 * No Razorpay plan ids: a paid tier is bought as a one-time Razorpay Order per
 * billing cycle, not an auto-recurring Razorpay Subscription, so there's no
 * Razorpay-side "Plan" object to reference — see `routes/billing.ts`.
 *
 * Adding or retiring a tier is a code change (and a deploy), same as adding a
 * new route — not something the admin UI can do.
 */
/** Analytics date-range keys, matching `stats-core.ts`'s `RANGES` plus "custom". */
export type RangeKey = "1h" | "24h" | "7d" | "30d" | "custom";

export type PlanCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  maxWorkspaces: number;
  maxSitesPerWorkspace: number;
  monthlyAuditQuota: number;
  monthlyCrawlQuota: number;
  features: string[];
  /** Display order on the pricing page; lower first. */
  sortOrder: number;
  /** Analytics date ranges this plan may query — everything else 402s. */
  allowedRanges: RangeKey[];
};

const ALL_RANGES: RangeKey[] = ["1h", "24h", "7d", "30d", "custom"];

export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    slug: "free",
    name: "Free",
    description: "Try SEO audits and crawls on a couple of sites.",
    maxWorkspaces: 2,
    maxSitesPerWorkspace: 2,
    monthlyAuditQuota: 3,
    monthlyCrawlQuota: 1,
    features: [],
    sortOrder: 0,
    allowedRanges: ["1h", "24h"],
  },
  {
    slug: "starter",
    name: "Starter",
    description: "For a single site in production.",
    maxWorkspaces: 5,
    maxSitesPerWorkspace: 5,
    monthlyAuditQuota: 10,
    monthlyCrawlQuota: 10,
    features: ["Email support"],
    sortOrder: 1,
    allowedRanges: ALL_RANGES,
  },
  {
    slug: "pro",
    name: "Pro",
    description: "For teams running SEO across several sites.",
    maxWorkspaces: 10,
    maxSitesPerWorkspace: 10,
    monthlyAuditQuota: 50,
    monthlyCrawlQuota: 50,
    features: ["Priority support", "Competitor tracking"],
    sortOrder: 2,
    allowedRanges: ALL_RANGES,
  },
];

export function getPlanCatalogEntry(slug: string): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((p) => p.slug === slug);
}
