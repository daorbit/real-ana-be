
export const MAX_SITES_PER_WORKSPACE = 2;

/** Analytics date-range keys, matching `stats-core.ts`'s `RANGES` plus "custom". */
export type RangeKey = "1h" | "24h" | "7d" | "30d" | "custom";

export type CompareModeKey = "previous" | "yoy" | "custom";

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
  compareModes: CompareModeKey[];
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
    compareModes: ["previous"],
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
    compareModes: ["previous", "custom"],
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
    compareModes: ["previous", "yoy", "custom"],
  },
];

export function getPlanCatalogEntry(slug: string): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((p) => p.slug === slug);
}
