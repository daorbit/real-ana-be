/**
 * Quantalog's implementation of the `OrbitHost` interface.
 *
 * This is the seam between the Orbit package (`src/orbit/`, which knows nothing
 * about this product) and everything that is specific to us: workspaces, plans,
 * subscriptions, quota storage, and analytics data.
 *
 * Every pricing decision about the assistant lives here rather than in the
 * package. If Orbit is ever extracted, this file stays behind.
 */

import { highestTier, type OrbitEntitlement, type OrbitHost, type OrbitTier } from "./index.js";
import {
  DEFAULT_ORBIT_PLAN_SLUG,
  resolveOrbitPlan,
  type OrbitPlanEntry,
} from "./orbit-plans.catalog.js";
import { Subscription } from "../billing/models/Subscription.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { hasQuota, spendQuota } from "../billing/quota.service.js";
import { workspaceDataSummary } from "./orbit-data.js";

/**
 * The Orbit tier each analytics plan includes.
 *
 * The rule someone paying for Quantalog actually expects: buying Pro gets you
 * the Pro assistant, without a second purchase. Without this, a customer on the
 * top analytics plan would hit an AI wall at twenty questions and read it as
 * stinginess rather than as "there is a second product".
 *
 * Buying an Orbit tier outright is still meaningful — it is how a workspace on
 * analytics Free reaches the better models, and how anyone exceeds what their
 * analytics plan grants. The two are compared and the stronger wins.
 */
const ORBIT_TIER_BY_PLAN: Record<string, string> = {
  free: "orbit-free",
  starter: "orbit-starter",
  pro: "orbit-pro",
};

/** Whether a period has run out. A null end date is treated as expired, not as unlimited. */
function lapsed(end?: Date | null): boolean {
  return !end || end.getTime() < Date.now();
}

/**
 * The Orbit plan a workspace is effectively on: the better of what its
 * analytics plan grants and what it has bought outright.
 *
 * Each side is checked against its own expiry, because the two are bought
 * separately and must lapse separately — an analytics plan running out should
 * not take a separately-paid Orbit tier down with it, or the other way round.
 * Both lapsing lands on Orbit Free, which costs us nothing to serve and keeps
 * the assistant answering rather than going dark on someone mid-conversation.
 */
export async function effectiveOrbitPlan(workspaceId: string): Promise<OrbitPlanEntry> {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) return resolveOrbitPlan(DEFAULT_ORBIT_PLAN_SLUG);

  // Granted by the analytics plan, while that plan's period is live.
  const analyticsPlan = lapsed(sub.currentPeriodEnd as Date | null)
    ? null
    : getPlanCatalogEntry(sub.planSlug as string);
  const granted = analyticsPlan
    ? resolveOrbitPlan(ORBIT_TIER_BY_PLAN[analyticsPlan.slug])
    : null;

  // Bought outright, while its own separate period is live.
  const purchasedSlug = sub.orbitPlanSlug as string | null;
  const purchased =
    purchasedSlug && purchasedSlug !== DEFAULT_ORBIT_PLAN_SLUG && !lapsed(sub.orbitPeriodEnd as Date | null)
      ? resolveOrbitPlan(purchasedSlug)
      : null;

  if (!granted && !purchased) return resolveOrbitPlan(DEFAULT_ORBIT_PLAN_SLUG);

  // Compared by model tier, then resolved back to whichever plan carries it —
  // so the winner brings its whole set of limits (quota, history, burst) rather
  // than a mix of the two, which would be impossible to explain on an invoice.
  const best: OrbitTier = highestTier(granted?.modelTier, purchased?.modelTier);
  const winner =
    purchased?.modelTier === best ? purchased : granted?.modelTier === best ? granted : null;

  return winner ?? resolveOrbitPlan(DEFAULT_ORBIT_PLAN_SLUG);
}

/** A catalogue plan as the entitlement the package understands. */
export function toEntitlement(plan: OrbitPlanEntry): OrbitEntitlement {
  return {
    tier: plan.modelTier,
    monthlyQuota: plan.monthlyQuota,
    maxHistoryTurns: plan.maxHistoryTurns,
    maxQuestionChars: plan.maxQuestionChars,
    hourlyBurst: plan.hourlyBurst,
    dataAccess: plan.dataAccess,
  };
}

/**
 * The host Orbit is given on every request.
 *
 * `tenantId` is a workspace id throughout — Orbit is metered per workspace,
 * like audits and crawls, because the workspace is what is sold.
 */
export const quantalogOrbitHost: OrbitHost = {
  async entitlement(workspaceId) {
    return toEntitlement(await effectiveOrbitPlan(workspaceId));
  },

  hasQuota(workspaceId) {
    return hasQuota(workspaceId, "orbit");
  },

  async spendQuota(workspaceId) {
    await spendQuota(workspaceId, "orbit");
  },

  dataSummary(workspaceId) {
    return workspaceDataSummary(workspaceId);
  },
};
