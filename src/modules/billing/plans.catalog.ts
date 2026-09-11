
export const MAX_SITES_PER_WORKSPACE = 2;

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "custom";

export type CompareModeKey = "previous" | "yoy" | "custom";

export type PlanCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  monthlyAuditQuota: number;
  monthlyCrawlQuota: number;
  monthlyEventQuota: number;
  features: string[];
  sortOrder: number;
  allowedRanges: RangeKey[];
  maxReportSchedules: number;
  maxReportRecipients: number;
  allowedReportFrequencies: Frequency[];
 
  whatsappReports: boolean;
 
  compareModes: CompareModeKey[];
 
  maxScheduledPosts: number;
 
  repeatingPosts: boolean;
 
  maxForms: number;

  monthlySubmissionQuota: number;

  formNotificationEmails: boolean;
  /** Whether a form may collect file and image uploads, which we then store. */
  formFileUploads: boolean;
  /** How many files a workspace may keep in its media library at once. */
  maxMediaAssets: number;
  /**
   * Whether the workspace may put its own name and logo on forms, payment
   * windows and notification emails — and take ours off. Free workspaces are
   * where the product is seen by people who have never heard of it, so the
   * caption stays there until someone is paying.
   */
  formBranding: boolean;
};

export type Frequency = "daily" | "weekly" | "monthly";

const ALL_RANGES: RangeKey[] = ["1h", "24h", "7d", "30d", "custom"];

 
const PLAN_CATALOG_INCREMENTAL: PlanCatalogEntry[] = [
  {
    slug: "free",
    name: "Free",
    description: "Real analytics for one small site, free forever.",
    monthlyAuditQuota: 3,
    monthlyCrawlQuota: 1,
    monthlyEventQuota: 10_000,

    features: [
      "7 days of history with period-over-period comparison",
      "1 lead capture form, up to 100 submissions / month",
      "3 scheduled social posts",
      "Monthly report by email",
      "Shareable public dashboard",
    ],
    sortOrder: 0,

    allowedRanges: ["1h", "24h", "7d"],
    maxReportSchedules: 1,
    maxReportRecipients: 1,
    allowedReportFrequencies: ["monthly"],
    whatsappReports: false,
    compareModes: ["previous"],
    maxScheduledPosts: 3,
    repeatingPosts: false,
    maxForms: 1,
    monthlySubmissionQuota: 100,
    formNotificationEmails: false,
    formFileUploads: false,
    formBranding: false,
    maxMediaAssets: 10,
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
    formBranding: false,
    maxMediaAssets: 50,
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
    formBranding: true,
    maxMediaAssets: 500,
  },
];

/**
 * Features a higher tier replaces rather than adds to, keyed by the feature
 * that supersedes them. Without this, Pro would advertise both "Email support"
 * and "Priority support".
 */
const SUPERSEDES: Record<string, string[]> = {
  "Priority support": ["Email support"],
  "Scheduled reports by email": ["Monthly report by email"],
  "Daily reports + WhatsApp alerts": ["Scheduled reports by email", "Monthly report by email"],
  "Year-over-year comparison": [
    "Custom comparison periods",
    "7 days of history with period-over-period comparison",
  ],
  "Custom comparison periods": ["7 days of history with period-over-period comparison"],
  "Unlimited scheduled social posts": ["Scheduled LinkedIn posts, including repeating", "3 scheduled social posts"],
  "Scheduled LinkedIn posts, including repeating": ["3 scheduled social posts"],
  "Lead capture forms with email notifications": ["1 lead capture form, up to 100 submissions / month"],
  "Lead capture forms with file uploads": ["Lead capture forms with email notifications"],
};

 
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
