import { Subscription, type BillingCycle } from "../models/Subscription.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import {
  getPlanCatalogEntry,
  MAX_SITES_PER_WORKSPACE,
  type RangeKey,
  type Frequency,
} from "../plans.js";
import { ReportSchedule } from "../models/ReportSchedule.js";

export type QuotaKind = "audit" | "crawl";

const CYCLE_DAYS: Record<BillingCycle, number> = { monthly: 30, yearly: 365 };

/**
 * Everything in this module is scoped to a *workspace*, not an account: a plan
 * is bought per workspace, so quota, limits, and expiry are all per workspace
 * too. `userId` is still passed to the write paths because a new subscription
 * row needs an owner, but it is never what a limit is counted against.
 */
export async function activatePlanPeriod(
  workspaceId: string,
  userId: string,
  planSlug: string,
  cycle: BillingCycle,
) {
  const now = new Date();
  const periodEnd = new Date(now.getTime() + CYCLE_DAYS[cycle] * 24 * 60 * 60 * 1000);
  await Subscription.findOneAndUpdate(
    { workspaceId },
    {
      $set: {
        userId,
        planSlug,
        cycle,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        auditsUsed: 0,
        crawlsUsed: 0,
      },
    },
    { upsert: true }
  );
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

/** The catalogue plan this workspace is on, or null if it has no subscription, an unknown slug, or a lapsed period. */
export async function currentPlan(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub || isExpired(sub)) return null;
  return getPlanCatalogEntry(sub.planSlug as string) ?? null;
}

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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to add a site" };

  const count = await Site.countDocuments({ workspaceId });
  if (count >= MAX_SITES_PER_WORKSPACE)
    return {
      ok: false,
      error: `a workspace holds up to ${MAX_SITES_PER_WORKSPACE} sites — create another workspace to track more`,
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to view analytics" };

  const key = (plan.allowedRanges.includes(range as RangeKey) ? range : null) as RangeKey | null;
  if (!key)
    return {
      ok: false,
      error: `this workspace's plan only supports ${plan.allowedRanges.join("/")} ranges — upgrade for 7d, 30d, and custom ranges`,
    };
  return { ok: true };
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to schedule reports" };

  if (excludeId) return { ok: true };

  const count = await ReportSchedule.countDocuments({ workspaceId });
  if (count >= plan.maxReportSchedules)
    return {
      ok: false,
      error: `this workspace's plan allows ${plan.maxReportSchedules} scheduled report${plan.maxReportSchedules === 1 ? "" : "s"} — upgrade to add more`,
    };
  return { ok: true };
}

/** Whether this workspace's plan includes WhatsApp report delivery at all. */
export async function canUseWhatsAppReports(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to schedule reports" };
  if (!plan.whatsappReports)
    return {
      ok: false,
      error: "WhatsApp delivery is a Pro feature — upgrade this workspace, or deliver this report by email",
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
): Promise<{ ok: true } | { ok: false; error: string }> {
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
    };

  if (recipientCount > plan.maxReportRecipients)
    return {
      ok: false,
      error: `this workspace's plan allows ${plan.maxReportRecipients} recipient${plan.maxReportRecipients === 1 ? "" : "s"} per report — upgrade to send to more people`,
    };

  return { ok: true };
}

/**
 * Whether `workspaceId` has room for one more audit or crawl this cycle,
 * without spending it. Used to give a clear pre-flight error instead of letting
 * the (slow, external) audit/crawl run and then discovering there was no quota.
 */
export async function hasQuota(workspaceId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ workspaceId });
  // No subscription, or a lapsed paid period, means no plan quota — but a
  // lapsed period can still have unspent addon credits, which never expire,
  // so this falls through to the credits check below rather than refusing
  // outright.
  if (!sub) return false;

  const plan = isExpired(sub) ? null : getPlanCatalogEntry(sub.planSlug as string);

  if (plan) {
    const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
    const used = kind === "audit" ? sub.auditsUsed : sub.crawlsUsed;
    if ((used as number) < planQuota) return true;
  }

  const addonCredits = kind === "audit" ? sub.addonAuditCredits : sub.addonCrawlCredits;
  return (addonCredits as number) > 0;
}

/**
 * Spend one unit of this workspace's quota, preferring the plan's own allowance
 * before dipping into purchased addon credits — a customer's addon purchase
 * should outlast this cycle's plan allotment, not get consumed alongside it.
 *
 * Returns false (and spends nothing) if there was no quota left; the caller
 * must check this *before* doing the expensive work, then call this to commit
 * the spend once the audit/crawl actually ran.
 */
export async function spendQuota(workspaceId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) return false;
  const plan = isExpired(sub) ? null : getPlanCatalogEntry(sub.planSlug as string);

  const usedField = kind === "audit" ? "auditsUsed" : "crawlsUsed";
  const creditField = kind === "audit" ? "addonAuditCredits" : "addonCrawlCredits";

  // Atomic conditional increments — two concurrent requests (double-click, two
  // tabs, a client retry) must not both read "quota left" before either
  // writes, or the workspace spends one more unit than it has. The condition is
  // re-checked by Mongo at write time, not by JS after a separate read.
  if (plan) {
    const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
    const spent = await Subscription.findOneAndUpdate(
      { workspaceId, [usedField]: { $lt: planQuota } },
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
  const plan = getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return null;

  const siteCount = await Site.countDocuments({ workspaceId });

  return {
    workspaceId: String(sub.workspaceId),
    plan: { slug: plan.slug, name: plan.name },
    cycle: sub.cycle,
    status: isExpired(sub) ? ("expired" as const) : sub.status,
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
    sites: {
      quota: MAX_SITES_PER_WORKSPACE,
      used: siteCount,
    },
    maxSitesPerWorkspace: MAX_SITES_PER_WORKSPACE,
    allowedRanges: plan.allowedRanges,
    // Sent with the profile for the same reason as allowedRanges: the report
    // form has to know before it's submitted, and a 402 after filling it in
    // reads as a bug rather than a plan boundary.
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
