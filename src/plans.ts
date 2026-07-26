/**
 * The fixed catalogue of subscription tiers.
 *
 * Everything about a plan except its price is decided in code, not the
 * database — quotas, workspace/site limits and Razorpay plan ids are the kind
 * of thing that should never silently drift because someone fat-fingered an
 * admin form. Only price is left editable at runtime (see `models/Plan.ts`),
 * because that's the one thing that legitimately changes without a deploy.
 *
 * Adding or retiring a tier is a code change (and a deploy), same as adding a
 * new route — not something the admin UI can do.
 */
export type PlanCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  razorpayPlanIdMonthly: string;
  razorpayPlanIdYearly: string;
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
    razorpayPlanIdMonthly: "",
    razorpayPlanIdYearly: "",
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
    // Set via env once created in the Razorpay dashboard (Subscriptions -> Plans).
    razorpayPlanIdMonthly: process.env.RAZORPAY_PLAN_STARTER_MONTHLY ?? "",
    razorpayPlanIdYearly: process.env.RAZORPAY_PLAN_STARTER_YEARLY ?? "",
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
    razorpayPlanIdMonthly: process.env.RAZORPAY_PLAN_PRO_MONTHLY ?? "",
    razorpayPlanIdYearly: process.env.RAZORPAY_PLAN_PRO_YEARLY ?? "",
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
