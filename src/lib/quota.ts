import { Subscription } from "../models/Subscription.js";
import { Plan } from "../models/Plan.js";

export type QuotaKind = "audit" | "crawl";

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

  const plan = await Plan.findById(sub.planId);
  if (!plan) return false;

  const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
  const used = kind === "audit" ? sub.auditsUsed : sub.crawlsUsed;
  if ((used as number) < (planQuota as number)) return true;

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
  const plan = await Plan.findById(sub.planId);
  if (!plan) return false;

  const planQuota = kind === "audit" ? plan.monthlyAuditQuota : plan.monthlyCrawlQuota;
  const usedField = kind === "audit" ? "auditsUsed" : "crawlsUsed";
  const creditField = kind === "audit" ? "addonAuditCredits" : "addonCrawlCredits";

  const used = sub.get(usedField) as number;
  if (used < (planQuota as number)) {
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
  const plan = await Plan.findById(sub.planId);
  if (!plan) return null;

  return {
    plan: { id: plan.id, name: plan.name, slug: plan.slug },
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
  };
}
