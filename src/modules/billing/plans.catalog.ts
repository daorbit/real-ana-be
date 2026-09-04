
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
  /**
   * Scheduled social posts a workspace may hold at once.
   *
   * Counted rather than metered per publish: the cost here is the stored queue
   * and the connection it publishes through, not the individual send. Free gets
   * enough to see the feature work on a real post; the paid draw is running a
   * content calendar rather than one post at a time.
   *
   * Zero switches the feature off entirely, which is what the composer reads to
   * decide whether to offer it at all.
   */
  maxScheduledPosts: number;
  /**
   * Whether a post may repeat on a cadence rather than going out once.
   *
   * The paid half of scheduling: a repeating post publishes unattended forever
   * from one row, which is the thing worth paying for, where a single post is
   * the thing worth trying.
   */
  repeatingPosts: boolean;
  /**
   * Lead capture forms a workspace may hold.
   *
   * Counted rather than metered, for the same reason as scheduled posts: a form
   * is stored state that costs us while it exists, not per use. One is enough to
   * publish something real and see responses arrive; running several — a contact
   * form, a signup, a survey — is the paid shape.
   */
  maxForms: number;

  monthlySubmissionQuota: number;

  formNotificationEmails: boolean;
  /** Whether a form may collect file and image uploads, which we then store. */
  formFileUploads: boolean;
};

/** Matches `models/ReportSchedule.ts`'s `FREQUENCIES`. */
export type Frequency = "daily" | "weekly" | "monthly";

const ALL_RANGES: RangeKey[] = ["1h", "24h", "7d", "30d", "custom"];

/**
 * Each tier lists only what it *adds* over the one below it. `PLAN_CATALOG`
 * below rolls these up, so consumers always see the full set a plan includes.
 * Authoring them incrementally keeps the diff between tiers obvious here;
 * shipping them incrementally made Pro look like it had lost the features
 * Starter introduced.
 */
const PLAN_CATALOG_INCREMENTAL: PlanCatalogEntry[] = [
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
    // Enough to schedule a post and watch it publish itself, which is the
    // whole argument for the feature. A calendar needs the paid tier.
    maxScheduledPosts: 3,
    repeatingPosts: false,
    // One published form, and enough responses to see it working on a real
    // site. Notifications and uploads are the outbound/storage costs, so they
    // are where the paid line sits.
    maxForms: 1,
    monthlySubmissionQuota: 100,
    formNotificationEmails: false,
    formFileUploads: false,
  },
  {
    slug: "starter",
    name: "Starter",
    description: "For a single site in production.",
    monthlyAuditQuota: 10,
    monthlyCrawlQuota: 10,
    monthlyEventQuota: 250_000,
    features: [
      "Email support",
      "Scheduled reports by email",
      "Custom comparison periods",
      "Scheduled LinkedIn posts, including repeating",
      "Lead capture forms with email notifications",
    ],
    sortOrder: 1,
    allowedRanges: ALL_RANGES,
    maxReportSchedules: 5,
    maxReportRecipients: 5,
    allowedReportFrequencies: ["weekly", "monthly"],
    whatsappReports: false,
    compareModes: ["previous", "custom"],
    maxScheduledPosts: 30,
    repeatingPosts: true,
    maxForms: 10,
    monthlySubmissionQuota: 2_000,
    formNotificationEmails: true,
    formFileUploads: true,
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
      "Unlimited scheduled social posts",
      "Lead capture forms with file uploads",
    ],
    sortOrder: 2,
    allowedRanges: ALL_RANGES,
    maxReportSchedules: 20,
    maxReportRecipients: 20,
    allowedReportFrequencies: ["daily", "weekly", "monthly"],
    whatsappReports: true,
    compareModes: ["previous", "yoy", "custom"],
    maxScheduledPosts: 500,
    repeatingPosts: true,
    maxForms: 50,
    monthlySubmissionQuota: 25_000,
    formNotificationEmails: true,
    formFileUploads: true,
  },
];

/**
 * Features a higher tier replaces rather than adds to, keyed by the feature
 * that supersedes them. Without this, Pro would advertise both "Email support"
 * and "Priority support".
 */
const SUPERSEDES: Record<string, string[]> = {
  "Priority support": ["Email support"],
  "Daily reports + WhatsApp alerts": ["Scheduled reports by email"],
  "Year-over-year comparison": ["Custom comparison periods"],
  "Unlimited scheduled social posts": ["Scheduled LinkedIn posts, including repeating"],
  "Lead capture forms with file uploads": ["Lead capture forms with email notifications"],
};

/**
 * The catalogue as the rest of the app sees it: every plan carries the full
 * list of what it includes, inherited from the tiers below it.
 */
export const PLAN_CATALOG: PlanCatalogEntry[] = (() => {
  const ordered = PLAN_CATALOG_INCREMENTAL.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  let inherited: string[] = [];

  return ordered.map((entry) => {
    const replaced = new Set(entry.features.flatMap((f) => SUPERSEDES[f] ?? []));
    const features = [
      ...inherited.filter((f) => !replaced.has(f)),
      ...entry.features.filter((f) => !inherited.includes(f)),
    ];
    inherited = features;
    return { ...entry, features };
  });
})();

export function getPlanCatalogEntry(slug: string): PlanCatalogEntry | undefined {
  return PLAN_CATALOG.find((p) => p.slug === slug);
}
