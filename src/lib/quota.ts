import { Subscription } from "../models/Subscription.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { getPlanCatalogEntry } from "../plans.js";

export type QuotaKind = "audit" | "crawl";

/** The catalogue plan the user is on, or null if they have no subscription (or an unknown slug). */
async function currentPlan(userId: string) {
  const sub = await Subscription.findOne({ userId });
  if (!sub) return null;
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
 * Whether `userId` has room for one more audit or crawl this cycle, without
 * spending it. Used to give a clear pre-flight error instead of letting the
 * (slow, external) audit/crawl run and then discovering there was no quota.
 */
export async function hasQuota(userId: string, kind: QuotaKind): Promise<boolean> {
  const sub = await Subscription.findOne({ userId });
  // No subscription at all means no plan quota and no addon credits — refuse
  // rather than silently allowing unlimited use.
  if (!sub) return false;

  const plan = getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return false;

  const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
  const used = kind === "audit" ? sub.auditsUsed : sub.crawlsUsed;
  if ((used as number) < planQuota) return true;

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
  const plan = getPlanCatalogEntry(sub.planSlug as string);
  if (!plan) return false;

  const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
  const usedField = kind === "audit" ? "auditsUsed" : "crawlsUsed";
  const creditField = kind === "audit" ? "addonAuditCredits" : "addonCrawlCredits";

  const used = sub.get(usedField) as number;
  if (used < planQuota) {
    sub.set(usedField, used + 1);
    await sub.save();
    return true;
  }

  const credits = sub.get(creditField) as number;
  if (credits > 0) {
    sub.set(creditField, credits - 1);
    await sub.save();
    return true;
  }

  return false;
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
    status: sub.status,
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
  };
}
