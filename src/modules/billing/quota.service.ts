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
import { invalidateSite } from "./event-quota.js";
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
        eventsUsed: 0,
        // Reset here and nowhere else, for the same reason as the counters
        // above: a purchase path that forgets one leaves a workspace paying for
        // a cycle it starts already over.
        submissionsUsed: 0,
      },
    },
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

/** The catalogue plan this workspace is on, or null if it has no subscription, an unknown slug, or a lapsed period. */
export async function currentPlan(workspaceId: string) {
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

/**
 * Whether `workspaceId` may publish one more form.
 *
 * Counts *published* forms only. A draft collects nothing and costs nothing, so
 * capping drafts would only stop someone drafting the form they are about to
 * upgrade for. `excludeId` lets a re-publish of an existing form skip counting
 * itself.
 */
export async function canCreateForm(
  workspaceId: string,
  excludeId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to publish forms" };

  // Imported lazily: `forms` reads this module for its own guards, and a static
  // import in both directions would be circular at load time.
  const { Form } = await import("../forms/models/Form.js");
  const count = await Form.countDocuments({
    workspaceId,
    status: "published",
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });

  if (count >= plan.maxForms)
    return {
      ok: false,
      error: `this workspace's plan allows ${plan.maxForms} published form${plan.maxForms === 1 ? "" : "s"} — upgrade to publish more`,
    };
  return { ok: true };
}

/**
 * Whether this workspace is still inside its submission allowance.
 *
 * Note the shape: this never refuses a submission. `ok: false` means "store it,
 * flag it, and do not send the notification" — the ingest path treats it as a
 * degraded accept, not a rejection. See `monthlySubmissionQuota` for why.
 */
export async function canAcceptSubmission(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  // No live plan is still not a refusal. A workspace whose period lapsed on a
  // Friday must not silently stop capturing leads over the weekend.
  if (!plan)
    return { ok: false, error: "this workspace has no active plan — submissions are captured but notifications are paused" };

  const sub = await Subscription.findOne({ workspaceId }).select("submissionsUsed");
  const used = (sub?.get("submissionsUsed") as number) ?? 0;
  if (used >= plan.monthlySubmissionQuota)
    return {
      ok: false,
      error: `this workspace has used its ${plan.monthlySubmissionQuota} submissions for the cycle — leads are still being captured, but email notifications are paused until you upgrade`,
    };
  return { ok: true };
}

/**
 * Record one accepted submission against the cycle.
 *
 * Unconditional `$inc`, unlike `spendQuota`: there is nothing to lose a race
 * over when going past the line is permitted. The count keeps rising past the
 * allowance so the banner can say how far over the workspace is.
 */
export async function recordSubmissionUsage(workspaceId: string): Promise<void> {
  await Subscription.updateOne({ workspaceId }, { $inc: { submissionsUsed: 1 } });
}

/**
 * Whether this workspace's plan may export submissions as CSV.
 *
 * Refused server-side as well as hidden in the UI, the same reasoning as
 * `canConfigureReport`: the export is the whole value of the stored leads, so a
 * hidden button is only the polite half of the limit.
 */
export async function canExportSubmissions(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const plan = await currentPlan(workspaceId);
  if (!plan) return { ok: false, error: "this workspace has no active plan — subscribe to export submissions" };
  if (!plan.formsCsvExport)
    return {
      ok: false,
      error: "CSV export is a paid feature — upgrade this workspace to download your submissions",
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
/**
 * This cycle's plan allowance for one quota kind, or null if there is no live
 * plan behind it.
 *
 * Orbit is read from its own ladder and its own expiry, so the two tiers lapse
 * independently. It also never returns null for a live workspace: an expired
 * Orbit period lands on Free, which still has an allowance.
 */
async function planAllowance(
  sub: { planSlug: unknown; currentPeriodEnd?: Date | null },
  workspaceId: string,
  kind: QuotaKind,
): Promise<number | null> {
  if (kind === "orbit") {
    // Imported lazily to break a cycle: `orbit-host` owns the rule for which
    // Orbit tier a workspace is effectively on — which depends on its analytics
    // plan — and in turn calls back into this module for the quota primitives.
    // A static import either way round would be circular at load time.
    const { effectiveOrbitPlan } = await import("../orbit/orbit-host.js");
    return (await effectiveOrbitPlan(workspaceId)).monthlyQuota;
  }

  const plan = isExpired(sub) ? null : getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return null;
  return kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
}

export async function hasQuota(workspaceId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ workspaceId });
  // No subscription, or a lapsed paid period, means no plan quota — but a
  // lapsed period can still have unspent addon credits, which never expire,
  // so this falls through to the credits check below rather than refusing
  // outright.
  if (!sub) return false;

  const fields = QUOTA_FIELDS[kind];
  const allowance = await planAllowance(sub, workspaceId, kind);

  if (allowance !== null) {
    const used = (sub.get(fields.used) as number) ?? 0;
    if (used < allowance) return true;
  }

  return (((sub.get(fields.credits) as number) ?? 0) > 0);
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

  const { used: usedField, credits: creditField } = QUOTA_FIELDS[kind];
  const allowance = await planAllowance(sub, workspaceId, kind);

  // Atomic conditional increments — two concurrent requests (double-click, two
  // tabs, a client retry) must not both read "quota left" before either
  // writes, or the workspace spends one more unit than it has. The condition is
  // re-checked by Mongo at write time, not by JS after a separate read.
  if (allowance !== null) {
    // The `$or` covers rows written before this field existed: Mongo's `$lt`
    // does not match a missing field, so without the null branch every
    // pre-Orbit subscription would read as having no allowance left and go
    // straight to credits it also does not have.
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
  const plan = getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return null;

  const siteCount = await Site.countDocuments({ workspaceId });
  // Lazy for the same cycle reason as `canCreateForm` above.
  const { Form } = await import("../forms/models/Form.js");
  const formCount = await Form.countDocuments({ workspaceId, status: "published" });
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
    /**
     * Ingested events this cycle.
     *
     * No `addonCredits`: events are not sold as a top-up pack, so the only way
     * past this line is a plan change. `used` trails real ingest by up to one
     * flush interval — see `event-quota.ts`.
     */
    events: {
      planQuota: plan.monthlyEventQuota,
      used: (sub.eventsUsed as number) ?? 0,
    },
    sites: {
      quota: MAX_SITES_PER_WORKSPACE,
      used: siteCount,
    },
    /**
     * Forms and lead capture.
     *
     * `used` here counts published forms, matching what `canCreateForm`
     * enforces. The submission figure can exceed its quota by design — the
     * limit is soft — so the dashboard must render `used > planQuota` as an
     * upgrade prompt rather than clamping it to the maximum.
     */
    forms: {
      planQuota: plan.maxForms,
      used: formCount,
      submissions: {
        planQuota: plan.monthlySubmissionQuota,
        used: (sub.get("submissionsUsed") as number) ?? 0,
      },
      csvExport: plan.formsCsvExport,
      removeBranding: plan.formsRemoveBranding,
    },
    maxSitesPerWorkspace: MAX_SITES_PER_WORKSPACE,
    allowedRanges: plan.allowedRanges,
    compareModes: plan.compareModes,
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
