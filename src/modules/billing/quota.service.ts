import { Subscription, type BillingCycle } from "./models/Subscription.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { Site } from "../analytics/models/Site.js";
import {
  getPlanCatalogEntry,
  MAX_SITES_PER_WORKSPACE,
  type RangeKey,
  type Frequency,
  type CompareModeKey,
} from "./plans.catalog.js";
import { ReportSchedule } from "../reports/models/ReportSchedule.js";
import { ScheduledPost } from "../social/models/ScheduledPost.js";
import { invalidateSite } from "./event-quota.js";
import type { PlanLimitInfo } from "../../http/plan-limit.js";
import {
  DEFAULT_ORBIT_PLAN_SLUG,
  resolveOrbitPlan,
  type OrbitPlanEntry,
} from "../orbit/orbit-plans.catalog.js";

export type QuotaKind = "audit" | "crawl" | "orbit";

/** Where each quota kind keeps its usage and its purchased credits. */
const QUOTA_FIELDS: Record<QuotaKind, { used: string; credits: string }> = {
  audit: { used: "auditsUsed", credits: "addonAuditCredits" },
  crawl: { used: "crawlsUsed", credits: "addonCrawlCredits" },
  orbit: { used: "orbitUsed", credits: "addonOrbitCredits" },
};

const CYCLE_DAYS: Record<BillingCycle, number> = { monthly: 30, yearly: 365 };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead a workspace may stack renewals. Renewing the same plan while
 * the current period is still live extends it; this caps that at two cycles of
 * runway so nobody prepays years and then asks for it all back.
 */
export const MAX_PREPAID_CYCLES = 2;

/** A renewal stacks only when the plan *and* the cycle are unchanged. */
function isSamePlanRenewal(
  sub: { planSlug?: unknown; cycle?: unknown; currentPeriodEnd?: Date | null } | null,
  planSlug: string,
  cycle: BillingCycle,
): boolean {
  if (!sub || isExpired(sub)) return false;
  if (planSlug === "free") return false; // Free has no period to extend.
  return sub.planSlug === planSlug && sub.cycle === cycle;
}

/**
 * Whether this workspace is already carrying its maximum prepaid runway, so a
 * further same-plan renewal must be refused. Checked at checkout time, before
 * any money moves.
 */
export async function renewalWouldExceedCap(
  workspaceId: string,
  planSlug: string,
  cycle: BillingCycle,
): Promise<boolean> {
  const sub = await Subscription.findOne({ workspaceId });
  if (!isSamePlanRenewal(sub, planSlug, cycle)) return false;
  const remainingMs = sub!.currentPeriodEnd!.getTime() - Date.now();
  return remainingMs >= MAX_PREPAID_CYCLES * CYCLE_DAYS[cycle] * DAY_MS;
}

/**
 * Everything in this module is scoped to a *workspace*, not an account: a plan
 * is bought per workspace, so quota, limits, and expiry are all per workspace
 * too. `userId` is still passed to the write paths because a new subscription
 * row needs an owner, but it is never what a limit is counted against.
 *
 * Two shapes of activation land here:
 *
 *  - **Fresh period** — a first purchase, a tier change, a cycle switch, or a
 *    renewal after the previous period already lapsed. The period runs from
 *    now, and the cycle's usage counters reset to zero.
 *
 *  - **Stacked renewal** — the same plan and cycle bought again while the
 *    current period is still live. The new cycle is added onto the existing
 *    end date rather than starting now, so the buyer keeps the days they had
 *    already paid for. Usage counters are left alone: the extra time was
 *    bought, not a second helping of this cycle's quota, and resetting here
 *    would let a workspace near its cap renew to wipe it early.
 *
 * Which of the two it is is decided here, from the stored subscription, not by
 * the caller — so the webhook and the client-side verify call cannot disagree,
 * and a renewal whose payment only lands after the period expires correctly
 * degrades to a fresh period.
 */
export async function activatePlanPeriod(
  workspaceId: string,
  userId: string,
  planSlug: string,
  cycle: BillingCycle,
) {
  const now = new Date();
  const existing = await Subscription.findOne({ workspaceId });
  const stacking = isSamePlanRenewal(existing, planSlug, cycle);

  const base = stacking ? existing!.currentPeriodEnd! : now;
  const periodEnd = new Date(base.getTime() + CYCLE_DAYS[cycle] * DAY_MS);

  const set: Record<string, unknown> = {
    userId,
    planSlug,
    cycle,
    status: "active",
    currentPeriodEnd: periodEnd,
    expiryRemindersSent: [],
  };

  // A stacked renewal keeps the period it is extending and this cycle's usage;
  // a fresh period restarts both.
  if (!stacking) {
    set.currentPeriodStart = now;
    set.auditsUsed = 0;
    set.crawlsUsed = 0;
    set.eventsUsed = 0;
    set.formSubmissionsUsed = 0;
  }

  await Subscription.findOneAndUpdate(
    { workspaceId },
    { $set: set },
    { upsert: true }
  );

  // Ingest caches its allow/deny decision per site for a minute, so without
  // this a workspace that just bought its way out of an exhausted quota would
  // keep dropping events after paying. Done here rather than at each call site
  // so no future purchase path can forget it.
  const sites = await Site.find({ workspaceId }).select("siteId");
  for (const s of sites) invalidateSite(s.get("siteId") as string);
}

/**
 * Give a brand-new workspace the Free plan immediately, so it is usable the
 * moment it is created rather than 402-ing on every route until something is
 * bought. Called on workspace creation, including the first workspace of a new
 * account.
 */
export async function assignFreePlan(workspaceId: string, userId: string) {
  await activatePlanPeriod(workspaceId, userId, "free", "monthly");
}

/**
 * A plan is bought as a one-time order for one cycle — there is no
 * auto-renewal, so "does this workspace still have access" is just "has its
 * paid period ended". A null `currentPeriodEnd` (shouldn't happen once
 * `activatePlanPeriod` has run at least once) is treated as expired rather
 * than as unlimited.
 */
function isExpired(sub: { currentPeriodEnd?: Date | null }): boolean {
  if (!sub.currentPeriodEnd) return true;
  return sub.currentPeriodEnd.getTime() < Date.now();
}

/**
 * The catalogue plan this workspace may use right now.
 *
 * A lapsed paid period falls back to Free rather than to nothing. Cutting a
 * workspace off entirely would leave it worse off than one that never paid —
 * unable to read the history it already bought — and the events kept flowing in
 * from a tracker that has no idea about billing. Free is the floor: tracking
 * continues at Free's allowance, the data stays readable at Free's ranges, and
 * only the paid features lock.
 *
 * Null still means "no subscription row at all" or an unknown slug, which is a
 * different thing from an expired one and is left to the caller.
 */
export async function currentPlan(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) return null;
  if (isExpired(sub)) return getPlanCatalogEntry("free") ?? null;
  return getPlanCatalogEntry(sub.planSlug as string) ?? null;
}

/**
 * The plan actually paid for, ignoring the Free fallback above.
 *
 * Only for deciding what may be bought next: a lapsed Pro workspace is on Free
 * for access purposes, but it must still be able to buy Starter, which the
 * downgrade guard would otherwise refuse.
 */
export async function paidPlan(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub || isExpired(sub)) return null;
  return getPlanCatalogEntry(sub.planSlug as string) ?? null;
}

/**
 * Start an Orbit plan period, resetting the question count.
 *
 * Separate from `activatePlanPeriod` because the two ladders are bought
 * independently — buying Orbit Pro must not restart the analytics period or
 * refund its audit quota.
 */
export async function activateOrbitPeriod(
  workspaceId: string,
  userId: string,
  orbitPlanSlug: string,
  cycle: BillingCycle,
) {
  const now = new Date();
  const periodEnd = new Date(now.getTime() + CYCLE_DAYS[cycle] * 24 * 60 * 60 * 1000);
  await Subscription.findOneAndUpdate(
    { workspaceId },
    { $set: { userId, orbitPlanSlug, orbitPeriodEnd: periodEnd, orbitUsed: 0 } },
    { upsert: true },
  );
}

/**
 * The answer to "may this workspace do that?".
 *
 * `limit` describes the cap that stopped it, and travels to the client so the
 * upgrade dialog can name which allowance ran out rather than making the reader
 * infer it from the sentence. Optional: a check that has nothing to count (a
 * feature the plan simply does not include) sends the prose alone.
 */
export type QuotaCheck =
  | { ok: true }
  | { ok: false; error: string; limit?: PlanLimitInfo };

/**
 * Whether `workspaceId` may hold one more site.
 *
 * The cap is flat across tiers (see `MAX_SITES_PER_WORKSPACE`) — the way to
 * track more sites is another workspace, which is another subscription. An
 * unpaid/lapsed workspace is refused outright rather than falling back to the
 * cap, so a workspace whose period ended cannot keep growing.
 */
export async function canCreateSite(
  workspaceId: string,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to add a site" };

  const sub = await Subscription.findOne({ workspaceId }).select("addonSiteSlots");
  const cap = MAX_SITES_PER_WORKSPACE + ((sub?.get("addonSiteSlots") as number) ?? 0);

  const count = await Site.countDocuments({ workspaceId });
  if (count >= cap)
    return {
      ok: false,
      error: `a workspace holds up to ${cap} sites — create another workspace to track more`,
      limit: { kind: "sites", label: "Sites", used: count, quota: cap, plan: plan.name },
    };
  return { ok: true };
}

/**
 * Whether this workspace's plan may query the given analytics date range. Free
 * is capped to 1h/24h; a request for 7d/30d/custom on Free is refused
 * server-side regardless of what the client sends — the range picker hiding the
 * option is only the friendly half of this.
 */
export async function canUseRange(
  workspaceId: string,
  range: string,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to view analytics" };

  const key = (plan.allowedRanges.includes(range as RangeKey) ? range : null) as RangeKey | null;
  if (!key)
    return {
      ok: false,
      error: `this workspace's plan only supports ${plan.allowedRanges.join("/")} ranges — upgrade for 7d, 30d, and custom ranges`,
      limit: { kind: "date_range", label: "Date range", plan: plan.name },
    };
  return { ok: true };
}

/**
 * Whether this workspace's plan may compare against the given baseline.
 *
 * Unlike `canUseRange`, a refusal here does not fail the request: the caller
 * falls back to "previous", which every tier has. Losing the year-over-year
 * overlay is a missing comparison, not a missing report, and 402-ing the whole
 * stats payload over it would blank a dashboard the plan is entitled to see.
 */
export async function canUseCompare(
  workspaceId: string,
  mode: string,
): Promise<boolean> {
  if (mode === "previous") return true;
  const plan = await currentPlan(workspaceId);
  if (!plan) return false;
  return plan.compareModes.includes(mode as CompareModeKey);
}

/**
 * Whether `workspaceId` may add one more emailed report schedule.
 *
 * `excludeId` lets an edit re-check the limits without the schedule being
 * edited counting against itself.
 */
export async function canCreateReportSchedule(
  workspaceId: string,
  excludeId?: string,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to schedule reports" };

  if (excludeId) return { ok: true };

  const count = await ReportSchedule.countDocuments({ workspaceId });
  if (count >= plan.maxReportSchedules)
    return {
      ok: false,
      error: `this workspace's plan allows ${plan.maxReportSchedules} scheduled report${plan.maxReportSchedules === 1 ? "" : "s"} — upgrade to add more`,
      limit: {
        kind: "report_schedules",
        label: "Scheduled reports",
        used: count,
        quota: plan.maxReportSchedules,
        plan: plan.name,
      },
    };
  return { ok: true };
}

/** Whether this workspace's plan includes WhatsApp report delivery at all. */
export async function canUseWhatsAppReports(
  workspaceId: string,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to schedule reports" };
  if (!plan.whatsappReports)
    return {
      ok: false,
      error: "WhatsApp delivery is a Pro feature — upgrade this workspace, or deliver this report by email",
      limit: { kind: "whatsapp_reports", label: "WhatsApp delivery", plan: plan.name },
    };
  return { ok: true };
}

/**
 * Whether a schedule's frequency and recipient count fit the workspace's plan.
 *
 * Checked server-side rather than trusted from the form: the recipient cap is
 * what stops a free workspace from using us as a mailing list, so the UI hiding
 * the "add" button is only the polite half of it.
 */
export async function canConfigureReport(
  workspaceId: string,
  frequency: string,
  recipientCount: number,
  wantsWhatsApp = false,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to schedule reports" };

  if (wantsWhatsApp && !plan.whatsappReports) {
    const wa = await canUseWhatsAppReports(workspaceId);
    if (!wa.ok) return wa;
  }

  if (!plan.allowedReportFrequencies.includes(frequency as Frequency))
    return {
      ok: false,
      error: `this workspace's plan supports ${plan.allowedReportFrequencies.join("/")} reports — upgrade for more frequent delivery`,
      limit: { kind: "report_frequency", label: "Report frequency", plan: plan.name },
    };

  if (recipientCount > plan.maxReportRecipients)
    return {
      ok: false,
      error: `this workspace's plan allows ${plan.maxReportRecipients} recipient${plan.maxReportRecipients === 1 ? "" : "s"} per report — upgrade to send to more people`,
      limit: {
        kind: "report_recipients",
        label: "Report recipients",
        used: recipientCount,
        quota: plan.maxReportRecipients,
        plan: plan.name,
      },
    };

  return { ok: true };
}


export async function canCreateScheduledPost(
  workspaceId: string,
  excludeId?: string,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to schedule posts" };

  // Bought slots add to the plan's own cap and never expire, so a workspace
  // that has paid for room keeps it across renewals and downgrades.
  const sub = await Subscription.findOne({ workspaceId });
  const bought = (sub?.get("addonPostSlots") as number) ?? 0;
  const cap = plan.maxScheduledPosts + bought;

  if (cap === 0)
    return {
      ok: false,
      error: "this workspace's plan does not include scheduled posts — upgrade to use them",
      limit: { kind: "scheduled_posts", label: "Scheduled posts", used: 0, quota: 0, plan: plan.name },
    };

  const count = await ScheduledPost.countDocuments({
    workspaceId,
    status: { $ne: "sent" },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
  if (count >= cap)
    return {
      ok: false,
      error: `this workspace can hold ${cap} scheduled post${cap === 1 ? "" : "s"} — upgrade or buy more slots to schedule beyond that`,
      limit: {
        kind: "scheduled_posts",
        label: "Scheduled posts",
        used: count,
        quota: cap,
        plan: plan.name,
      },
    };
  return { ok: true };
}

 
export async function formLimits(workspaceId: string) {

  const plan = (await currentPlan(workspaceId)) ?? getPlanCatalogEntry("free")!;
  const sub = await Subscription.findOne({ workspaceId }).select(
    "formSubmissionsUsed addonFormSubmissionCredits",
  );

  return {
    plan: plan.slug,
    // The display name too: the forms service builds its own limit dialogs and
    // would otherwise have to keep its own slug-to-name table in sync with this
    // catalogue.
    planName: plan.name,
    maxForms: plan.maxForms,
    monthlySubmissionQuota: plan.monthlySubmissionQuota,
    submissionsUsed: (sub?.get("formSubmissionsUsed") as number) ?? 0,
    submissionCredits: (sub?.get("addonFormSubmissionCredits") as number) ?? 0,
    notificationEmails: plan.formNotificationEmails,
    fileUploads: plan.formFileUploads,
  };
}

export async function recordFormSubmission(workspaceId: string): Promise<void> {
  const plan = (await currentPlan(workspaceId)) ?? getPlanCatalogEntry("free")!;

  const withinPlan = await Subscription.findOneAndUpdate(
    {
      workspaceId,
      $or: [
        { formSubmissionsUsed: { $lt: plan.monthlySubmissionQuota } },
        { formSubmissionsUsed: { $exists: false } },
      ],
    },
    { $inc: { formSubmissionsUsed: 1 } },
  );
  if (withinPlan) return;

  const credited = await Subscription.findOneAndUpdate(
    { workspaceId, addonFormSubmissionCredits: { $gt: 0 } },
    { $inc: { addonFormSubmissionCredits: -1 } },
  );
  // Neither had room: the response is stored regardless, so this only records
  // that the workspace is now over its allowance.
  if (!credited) {
    await Subscription.updateOne({ workspaceId }, { $inc: { formSubmissionsUsed: 1 } });
  }
}

/** Whether this workspace's plan allows a post to repeat rather than go out once. */
export async function canUseRepeatingPosts(
  workspaceId: string,
): Promise<QuotaCheck> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan" };
  if (!plan.repeatingPosts)
    return {
      ok: false,
      error: "repeating posts are not included in this workspace's plan — upgrade to use them",
      limit: { kind: "repeating_posts", label: "Repeating posts", plan: plan.name },
    };
  return { ok: true };
}


async function planAllowance(
  sub: { planSlug: unknown; currentPeriodEnd?: Date | null },
  workspaceId: string,
  kind: QuotaKind,
): Promise<number | null> {
  if (kind === "orbit") {

    const { effectiveOrbitPlan } = await import("../orbit/orbit-host.js");
    return (await effectiveOrbitPlan(workspaceId)).monthlyQuota;
  }

  const plan = isExpired(sub) ? null : getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return null;
  return kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
}

export async function hasQuota(workspaceId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) return false;

  const fields = QUOTA_FIELDS[kind];
  const allowance = await planAllowance(sub, workspaceId, kind);

  if (allowance !== null) {
    const used = (sub.get(fields.used) as number) ?? 0;
    if (used < allowance) return true;
  }

  return (((sub.get(fields.credits) as number) ?? 0) > 0);
}

export async function spendQuota(workspaceId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) return false;

  const { used: usedField, credits: creditField } = QUOTA_FIELDS[kind];
  const allowance = await planAllowance(sub, workspaceId, kind);

  if (allowance !== null) {

    const spent = await Subscription.findOneAndUpdate(
      {
        workspaceId,
        $or: [{ [usedField]: { $lt: allowance } }, { [usedField]: { $exists: false } }],
      },
      { $inc: { [usedField]: 1 } },
    );
    if (spent) return true;
  }

  const credited = await Subscription.findOneAndUpdate(
    { workspaceId, [creditField]: { $gt: 0 } },
    { $inc: { [creditField]: -1 } },
  );
  return Boolean(credited);
}

/** Remaining quota for one workspace, for the dashboard's usage display. */
export async function quotaSummary(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) return null;

  // The plan whose limits actually apply, which after a lapsed period is Free
  // rather than whatever was last bought. Reporting the bought plan here would
  // show a workspace quotas it cannot spend.
  const expired = isExpired(sub);
  const boughtSlug = sub.planSlug as string;
  const plan = getPlanCatalogEntry(expired ? "free" : boughtSlug);
  if (!plan) return null;
  const boughtPlan = getPlanCatalogEntry(boughtSlug);

  // Only what is still queued: a sent post is history and holds no slot, which
  // is the same rule `canCreateScheduledPost` counts by.
  const [siteCount, scheduledPostCount] = await Promise.all([
    Site.countDocuments({ workspaceId }),
    ScheduledPost.countDocuments({ workspaceId, status: { $ne: "sent" } }),
  ]);
  // Lazy for the same cycle reason as `planAllowance` above.
  const { effectiveOrbitPlan } = await import("../orbit/orbit-host.js");
  const orbitPlan = await effectiveOrbitPlan(workspaceId);

  return {
    orbit: {
      plan: { slug: orbitPlan.slug, name: orbitPlan.name },
      tier: orbitPlan.modelTier,
      planQuota: orbitPlan.monthlyQuota,
      used: (sub.orbitUsed as number) ?? 0,
      addonCredits: (sub.addonOrbitCredits as number) ?? 0,
      periodEnd: sub.orbitPeriodEnd ?? null,
      dataAccess: orbitPlan.dataAccess,
    },
    workspaceId: String(sub.workspaceId),
    plan: { slug: plan.slug, name: plan.name },
    /**
     * The plan that lapsed, when one has. Null while the period is live. The
     * dashboard needs it to say what expired — `plan` above has already fallen
     * back to Free by then and cannot answer that.
     */
    lapsedPlan:
      expired && boughtPlan && boughtPlan.slug !== "free"
        ? { slug: boughtPlan.slug, name: boughtPlan.name }
        : null,
    cycle: sub.cycle,
    status: expired ? ("expired" as const) : sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    audits: {
      planQuota: plan.monthlyAuditQuota,
      used: sub.auditsUsed,
      addonCredits: sub.addonAuditCredits,
    },
    crawls: {
      planQuota: plan.monthlyCrawlQuota,
      used: sub.crawlsUsed,
      addonCredits: sub.addonCrawlCredits,
    },
    events: {
      planQuota: plan.monthlyEventQuota,
      used: (sub.eventsUsed as number) ?? 0,
    },
    sites: {
      quota: MAX_SITES_PER_WORKSPACE + ((sub.get("addonSiteSlots") as number) ?? 0),
      used: siteCount,
      addonSlots: (sub.get("addonSiteSlots") as number) ?? 0,
    },
    maxSitesPerWorkspace: MAX_SITES_PER_WORKSPACE,

    scheduledPosts: {
      quota: plan.maxScheduledPosts + (((sub.get("addonPostSlots") as number) ?? 0)),
      used: scheduledPostCount,
      repeatingAllowed: plan.repeatingPosts,
    },
    /**
     * How many forms exist is not counted here: the forms service owns those
     * rows, and asking it on every billing page load would make this endpoint
     * depend on another service being up. The cap and the submission meter are
     * the parts this side owns, and they are what the usage display needs.
     */
    forms: {
      quota: plan.maxForms,
      submissionQuota: plan.monthlySubmissionQuota,
      submissionsUsed: (sub.get("formSubmissionsUsed") as number) ?? 0,
      addonCredits: (sub.get("addonFormSubmissionCredits") as number) ?? 0,
      notificationEmails: plan.formNotificationEmails,
      fileUploads: plan.formFileUploads,
    },
    allowedRanges: plan.allowedRanges,
    compareModes: plan.compareModes,
    whatsappReports: plan.whatsappReports,
  };
}

/**
 * Every workspace an account owns, with its plan and usage.
 *
 * For the admin console, which asks about *someone else's* account and so has
 * no active workspace to read from. The dashboard never uses this: a signed-in
 * user gets each workspace's plan attached to the workspace itself, which is
 * also what stays correct once a workspace can be reached by someone who does
 * not own it.
 *
 * Workspaces without a subscription row (shouldn't happen post-migration, but
 * a failed create could leave one) are returned with `billing: null` rather
 * than omitted, so the console can show the gap instead of hiding it.
 */
export async function accountBillingSummary(userId: string) {
  const workspaces = await Workspace.find({ userId }).select("name slug").sort({ createdAt: 1 });

  return Promise.all(
    workspaces.map(async (ws) => ({
      workspaceId: ws.id,
      name: ws.name as string,
      slug: ws.slug as string,
      billing: await quotaSummary(ws.id),
    })),
  );
}
