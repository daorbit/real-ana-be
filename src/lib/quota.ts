import { Subscription, type BillingCycle } from "../models/Subscription.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { getPlanCatalogEntry, type RangeKey, type Frequency } from "../plans.js";
import { ReportSchedule } from "../models/ReportSchedule.js";

export type QuotaKind = "audit" | "crawl";

const CYCLE_DAYS: Record<BillingCycle, number> = { monthly: 30, yearly: 365 };

 
export async function activatePlanPeriod(userId: string, planSlug: string, cycle: BillingCycle) {
  const now = new Date();
  const periodEnd = new Date(now.getTime() + CYCLE_DAYS[cycle] * 24 * 60 * 60 * 1000);
  await Subscription.findOneAndUpdate(
    { userId },
    {
      $set: {
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

/** Give a brand-new account the Free plan immediately, so it never has zero quota. */
export async function assignFreePlan(userId: string) {
  await activatePlanPeriod(userId, "free", "monthly");
}

/**
 * A plan is bought as a one-time order for one cycle — there is no
 * auto-renewal, so "does this user still have access" is just "has their
 * paid period ended". A null `currentPeriodEnd` (shouldn't happen once
 * `activatePlanPeriod` has run at least once) is treated as expired rather
 * than as unlimited.
 */
function isExpired(sub: { currentPeriodEnd?: Date | null }): boolean {
  if (!sub.currentPeriodEnd) return true;
  return sub.currentPeriodEnd.getTime() < Date.now();
}

/** The catalogue plan the user is on, or null if they have no subscription, an unknown slug, or their period has lapsed. */
export async function currentPlan(userId: string) {
  const sub = await Subscription.findOne({ userId });
  if (!sub || isExpired(sub)) return null;
  return getPlanCatalogEntry(sub.planSlug as string) ?? null;
}

/** Whether `userId` may create one more workspace under their plan. */
export async function canCreateWorkspace(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(userId);
  if (!plan) return { ok: false, error: "no active plan — subscribe to create a workspace" };

  const count = await Workspace.countDocuments({ userId });
  if (count >= plan.maxWorkspaces)
    return {
      ok: false,
      error: `your plan allows ${plan.maxWorkspaces} workspace${plan.maxWorkspaces === 1 ? "" : "s"} — upgrade to add more`,
    };
  return { ok: true };
}

/** Whether `userId` may add one more site to `workspaceId` under their plan. */
export async function canCreateSite(
  userId: string,
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(userId);
  if (!plan) return { ok: false, error: "no active plan — subscribe to add a site" };

  const count = await Site.countDocuments({ workspaceId });
  if (count >= plan.maxSitesPerWorkspace)
    return {
      ok: false,
      error: `your plan allows ${plan.maxSitesPerWorkspace} site${plan.maxSitesPerWorkspace === 1 ? "" : "s"} per workspace — upgrade to add more`,
    };
  return { ok: true };
}

/**
 * Whether `userId`'s plan may query the given analytics date range. Free is
 * capped to 1h/24h; a request for 7d/30d/custom on Free is refused server-side
 * regardless of what the client sends — the range picker hiding the option is
 * only the friendly half of this.
 */
export async function canUseRange(userId: string, range: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(userId);
  if (!plan) return { ok: false, error: "no active plan — subscribe to view analytics" };

  const key = (plan.allowedRanges.includes(range as RangeKey) ? range : null) as RangeKey | null;
  if (!key)
    return {
      ok: false,
      error: `your plan only supports ${plan.allowedRanges.join("/")} ranges — upgrade for 7d, 30d, and custom ranges`,
    };
  return { ok: true };
}

/**
 * Whether `userId` may add one more emailed report schedule to `workspaceId`.
 *
 * `excludeId` lets an edit re-check the limits without the schedule being
 * edited counting against itself.
 */
export async function canCreateReportSchedule(
  userId: string,
  workspaceId: string,
  excludeId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(userId);
  if (!plan) return { ok: false, error: "no active plan — subscribe to schedule reports" };

  if (excludeId) return { ok: true };

  const count = await ReportSchedule.countDocuments({ workspaceId });
  if (count >= plan.maxReportSchedules)
    return {
      ok: false,
      error: `your plan allows ${plan.maxReportSchedules} scheduled report${plan.maxReportSchedules === 1 ? "" : "s"} per workspace — upgrade to add more`,
    };
  return { ok: true };
}

/**
 * Whether a schedule's frequency and recipient count fit the user's plan.
 *
 * Checked server-side rather than trusted from the form: the recipient cap is
 * what stops a free account from using us as a mailing list, so the UI hiding
 * the "add" button is only the polite half of it.
 */
/** Whether this user's plan includes WhatsApp report delivery at all. */
export async function canUseWhatsAppReports(
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(userId);
  if (!plan) return { ok: false, error: "no active plan — subscribe to schedule reports" };
  if (!plan.whatsappReports)
    return {
      ok: false,
      error: "WhatsApp delivery is a Pro feature — upgrade, or deliver this report by email",
    };
  return { ok: true };
}

export async function canConfigureReport(
  userId: string,
  frequency: string,
  recipientCount: number,
  wantsWhatsApp = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(userId);
  if (!plan) return { ok: false, error: "no active plan — subscribe to schedule reports" };

  if (wantsWhatsApp && !plan.whatsappReports) {
    const wa = await canUseWhatsAppReports(userId);
    if (!wa.ok) return wa;
  }

  if (!plan.allowedReportFrequencies.includes(frequency as Frequency))
    return {
      ok: false,
      error: `your plan supports ${plan.allowedReportFrequencies.join("/")} reports — upgrade for more frequent delivery`,
    };

  if (recipientCount > plan.maxReportRecipients)
    return {
      ok: false,
      error: `your plan allows ${plan.maxReportRecipients} recipient${plan.maxReportRecipients === 1 ? "" : "s"} per report — upgrade to send to more people`,
    };

  return { ok: true };
}

/**
 * Whether `userId` has room for one more audit or crawl this cycle, without
 * spending it. Used to give a clear pre-flight error instead of letting the
 * (slow, external) audit/crawl run and then discovering there was no quota.
 */
export async function hasQuota(userId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ userId });
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
 * Spend one unit of quota, preferring the plan's own allowance before dipping
 * into purchased addon credits — a customer's addon purchase should outlast
 * this cycle's plan allotment, not get consumed alongside it.
 *
 * Returns false (and spends nothing) if there was no quota left; the caller
 * must check this *before* doing the expensive work, then call this to commit
 * the spend once the audit/crawl actually ran.
 */
export async function spendQuota(userId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ userId });
  if (!sub) return false;
  const plan = isExpired(sub) ? null : getPlanCatalogEntry(sub.planSlug as string);

  const usedField = kind === "audit" ? "auditsUsed" : "crawlsUsed";
  const creditField = kind === "audit" ? "addonAuditCredits" : "addonCrawlCredits";

  // Atomic conditional increments — two concurrent requests (double-click, two
  // tabs, a client retry) must not both read "quota left" before either
  // writes, or the user spends one more unit than they have. The condition is
  // re-checked by Mongo at write time, not by JS after a separate read.
  if (plan) {
    const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
    const spent = await Subscription.findOneAndUpdate(
      { userId, [usedField]: { $lt: planQuota } },
      { $inc: { [usedField]: 1 } },
    );
    if (spent) return true;
  }

  const credited = await Subscription.findOneAndUpdate(
    { userId, [creditField]: { $gt: 0 } },
    { $inc: { [creditField]: -1 } },
  );
  return Boolean(credited);
}

/** Remaining quota for the dashboard's usage display. */
export async function quotaSummary(userId: string) {
  const sub = await Subscription.findOne({ userId });
  if (!sub) return null;
  const plan = getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return null;

  const workspaceCount = await Workspace.countDocuments({ userId });

  return {
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
    workspaces: {
      quota: plan.maxWorkspaces,
      used: workspaceCount,
    },
    maxSitesPerWorkspace: plan.maxSitesPerWorkspace,
    allowedRanges: plan.allowedRanges,
  };
}
