/**
 * The fixed catalogue of subscription tiers.
 *
 * Everything about a plan except its price is decided in code, not the
 * database — quotas and feature limits are the kind of thing that should never
 * silently drift because someone fat-fingered an admin form.
 *
 * A plan is bought per workspace, not per account (see `models/Subscription.ts`),
 * so nothing here caps how many workspaces an account may have: another
 * workspace is another purchase. The per-workspace site cap is likewise a flat
 * constant, `MAX_SITES_PER_WORKSPACE`, rather than a tier field.
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
/**
 * Sites one workspace may hold, on every tier.
 *
 * Not a per-plan field: a workspace is the billable unit, so growth is sold by
 * buying another workspace rather than by widening this one. Keeping it flat
 * across tiers is what makes that pricing story true — if Pro held ten sites,
 * upgrading would be the cheaper way to add sites and workspaces would stop
 * being what people pay for.
 */
export const MAX_SITES_PER_WORKSPACE = 2;

/** Analytics date-range keys, matching `stats-core.ts`'s `RANGES` plus "custom". */
export type RangeKey = "1h" | "24h" | "7d" | "30d" | "custom";

export type PlanCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  monthlyAuditQuota: number;
  monthlyCrawlQuota: number;
  features: string[];
  /** Display order on the pricing page; lower first. */
  sortOrder: number;
  /** Analytics date ranges this plan may query — everything else 402s. */
  allowedRanges: RangeKey[];
  /** How many emailed report schedules a workspace may have. */
  maxReportSchedules: number;
  /** Addresses one schedule may send to, owner included. */
  maxReportRecipients: number;
  /** How often a schedule may run. Free gets monthly only — a daily digest is the paid draw. */
  allowedReportFrequencies: Frequency[];
  /**
   * Whether reports may be delivered over WhatsApp.
   *
   * Paid-only because every message costs us gateway spend against one shared
   * sender number, so an unmetered free tier on it is a bill with no ceiling.
   */
  whatsappReports: boolean;
};

/** Matches `models/ReportSchedule.ts`'s `FREQUENCIES`. */
export type Frequency = "daily" | "weekly" | "monthly";

const ALL_RANGES: RangeKey[] = ["1h", "24h", "7d", "30d", "custom"];

export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    slug: "free",
    name: "Free",
    description: "Try SEO audits and crawls on a couple of sites.",
    monthlyAuditQuota: 3,
    monthlyCrawlQuota: 1,
    features: [],
    sortOrder: 0,
    allowedRanges: ["1h", "24h"],
    maxReportSchedules: 1,
    // Owner only: mailing a free account's chosen third parties is the part
    // that costs us deliverability reputation, so it's the part that's paid.
    maxReportRecipients: 1,
    allowedReportFrequencies: ["monthly"],
    whatsappReports: false,
  },
  {
    slug: "starter",
    name: "Starter",
    description: "For a single site in production.",
    monthlyAuditQuota: 10,
    monthlyCrawlQuota: 10,
    features: ["Email support", "Scheduled reports by email"],
    sortOrder: 1,
    allowedRanges: ALL_RANGES,
    maxReportSchedules: 5,
    maxReportRecipients: 5,
    allowedReportFrequencies: ["weekly", "monthly"],
    whatsappReports: false,
  },
  {
    slug: "pro",
    name: "Pro",
    description: "For teams running SEO across several sites.",
    monthlyAuditQuota: 50,
    monthlyCrawlQuota: 50,
    features: ["Priority support", "Competitor tracking", "Daily reports + WhatsApp alerts"],
    sortOrder: 2,
    allowedRanges: ALL_RANGES,
    maxReportSchedules: 20,
    maxReportRecipients: 20,
    allowedReportFrequencies: ["daily", "weekly", "monthly"],
    whatsappReports: true,
  },
];

export function getPlanCatalogEntry(slug: string): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((p) => p.slug === slug);
}
