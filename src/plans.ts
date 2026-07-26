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
};

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
  },
];

export function getPlanCatalogEntry(slug: string): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((p) => p.slug === slug);
}
