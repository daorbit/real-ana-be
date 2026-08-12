
export const MAX_SITES_PER_WORKSPACE = 2;

/** Analytics date-range keys, matching `stats-core.ts`'s `RANGES` plus "custom". */
export type RangeKey = "1h" | "24h" | "7d" | "30d" | "custom";

/** Comparison baselines, matching `stats.service.ts`'s `CompareMode`. */
export type CompareModeKey = "previous" | "yoy" | "custom";

export type PlanCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  monthlyAuditQuota: number;
  monthlyCrawlQuota: number;
  /**
   * Analytics events a workspace may ingest per cycle.
   *
   * This is the meter that matches what the product actually costs us to run:
   * ingest is per-event write load and storage, where history depth is the same
   * single query either way. Metering events rather than date ranges is what
   * lets Free see a useful window without giving away the expensive part.
   *
   * Over quota, ingest is refused — but the dashboard keeps working and the
   * events already collected stay readable. Losing the numbers you already paid
   * for is a worse outcome than a gap in new ones.
   */
  monthlyEventQuota: number;
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
  /**
   * Which baselines the dashboard may compare a window against.
   *
   * Every tier keeps "previous" — the headline deltas have always been measured
   * against the preceding period and taking that away would be a downgrade. The
   * chosen baselines are the paid part: year-over-year needs a year of history
   * to be worth anything, which is exactly the customer who has been paying.
   */
  compareModes: CompareModeKey[];

  /** Published forms a workspace may hold. Drafts are free — an unpublished form collects nothing. */
  maxForms: number;
  /**
   * Submissions a workspace may take per cycle.
   *
   * Soft, unlike every other quota here: over the line submissions are still
   * stored and flagged, and it is the *notifications* that stop. A dropped
   * analytics event is a gap in a chart; a dropped lead is lost revenue, and a
   * customer who loses one does not upgrade, they leave. This inverts the
   * pressure correctly — they upgrade to get their notifications back.
   *
   * The consequence, stated rather than hidden: submission volume is not a hard
   * cost ceiling. `maxForms` and the per-form and per-IP rate limits are.
   */
  monthlySubmissionQuota: number;
  formsCsvExport: boolean;
  /** Reserved for v2. Present so the ladder does not need reshaping when uploads land. */
  formsFileUploads: boolean;
  /**
   * Whether the hosted page may drop the "Powered by Quantalog" line.
   *
   * Free keeps it deliberately: free hosted forms sitting on other people's
   * sites are the cheapest acquisition this product has.
   */
  formsRemoveBranding: boolean;
};

/** Matches `models/ReportSchedule.ts`'s `FREQUENCIES`. */
export type Frequency = "daily" | "weekly" | "monthly";

const ALL_RANGES: RangeKey[] = ["1h", "24h", "7d", "30d", "custom"];

export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    slug: "free",
    name: "Free",
    description: "Real analytics for one small site, free forever.",
    monthlyAuditQuota: 3,
    monthlyCrawlQuota: 1,
    monthlyEventQuota: 10_000,
    features: [],
    sortOrder: 0,
    /**
     * 7d, where this used to stop at 24h.
     *
     * A day of history is not enough to form the habit that makes anyone
     * upgrade — no week-over-week read, no weekend/weekday shape, and every
     * comparison feature invisible. History is also the cheap thing to serve:
     * the same query either way. The event quota above is the real limit, and
     * it is the one that tracks what a workspace costs us.
     */
    allowedRanges: ["1h", "24h", "7d"],
    maxReportSchedules: 1,
    // Owner only: mailing a free account's chosen third parties is the part
    // that costs us deliverability reputation, so it's the part that's paid.
    maxReportRecipients: 1,
    allowedReportFrequencies: ["monthly"],
    whatsappReports: false,
    compareModes: ["previous"],
    maxForms: 1,
    monthlySubmissionQuota: 100,
    formsCsvExport: false,
    formsFileUploads: false,
    formsRemoveBranding: false,
  },
  {
    slug: "starter",
    name: "Starter",
    description: "For a single site in production.",
    monthlyAuditQuota: 10,
    monthlyCrawlQuota: 10,
    monthlyEventQuota: 250_000,
    features: ["Email support", "Scheduled reports by email", "Custom comparison periods"],
    sortOrder: 1,
    allowedRanges: ALL_RANGES,
    maxReportSchedules: 5,
    maxReportRecipients: 5,
    allowedReportFrequencies: ["weekly", "monthly"],
    whatsappReports: false,
    compareModes: ["previous", "custom"],
    maxForms: 5,
    monthlySubmissionQuota: 2_000,
    formsCsvExport: true,
    formsFileUploads: false,
    formsRemoveBranding: true,
  },
  {
    slug: "pro",
    name: "Pro",
    description: "For teams running SEO across several sites.",
    monthlyAuditQuota: 50,
    monthlyCrawlQuota: 50,
    monthlyEventQuota: 2_000_000,
    features: [
      "Priority support",
      "Competitor tracking",
      "Daily reports + WhatsApp alerts",
      "Year-over-year comparison",
    ],
    sortOrder: 2,
    allowedRanges: ALL_RANGES,
    maxReportSchedules: 20,
    maxReportRecipients: 20,
    allowedReportFrequencies: ["daily", "weekly", "monthly"],
    whatsappReports: true,
    compareModes: ["previous", "yoy", "custom"],
    maxForms: 25,
    monthlySubmissionQuota: 20_000,
    formsCsvExport: true,
    formsFileUploads: false,
    formsRemoveBranding: true,
  },
];

export function getPlanCatalogEntry(slug: string): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((p) => p.slug === slug);
}
