import { PlanPurchase } from "./models/PlanPurchase.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { CURRENCIES, type Currency } from "./currency.js";
import type { ResolvedPlan } from "./plan-pricing.js";

export const PRICE_CHANGE_CUTOFF = new Date("2026-09-27T00:00:00Z");

const LEGACY_PRICES_INR: Record<string, { monthly: number; yearly: number }> = {
  starter: { monthly: 99900, yearly: 999900 },
  pro: { monthly: 999900, yearly: 9999900 },
};

async function paidBeforeCutoff(workspaceId: string, planSlug: string): Promise<boolean> {
  const workspace = await Workspace.findById(workspaceId).select("userId");
  const owner = workspace?.get("userId");
  const oldest = owner
    ? await Workspace.findOne({ userId: owner }).sort({ createdAt: 1 }).select("_id")
    : null;
  const ownsLegacyPurchases = oldest && String(oldest._id) === String(workspaceId);

  const found = await PlanPurchase.exists({
    planSlug,
    status: "paid",
    gateway: { $ne: "coupon" },
    ladder: { $ne: "orbit" },
    createdAt: { $lt: PRICE_CHANGE_CUTOFF },
    $or: [{ workspaceId }, ...(ownsLegacyPurchases ? [{ workspaceId: null, userId: owner }] : [])],
  });
  return Boolean(found);
}

function lockedPrices(
  current: Record<Currency, number>,
  legacyInr: number,
): Record<Currency, number> {
  const baseNow = current.INR;
  return Object.fromEntries(
    CURRENCIES.map((c) => {
      const legacy = c === "INR" ? legacyInr : baseNow > 0 ? Math.round((legacyInr * current[c]) / baseNow) : current[c];
      return [c, Math.min(current[c], legacy)];
    }),
  ) as Record<Currency, number>;
}

export async function applyPriceLock(workspaceId: string, plan: ResolvedPlan): Promise<ResolvedPlan> {
  const legacy = LEGACY_PRICES_INR[plan.slug];
  if (!legacy) return plan;
  if (!(await paidBeforeCutoff(workspaceId, plan.slug))) return plan;

  return {
    ...plan,
    priceMonthly: lockedPrices(plan.priceMonthly, legacy.monthly),
    priceYearly: lockedPrices(plan.priceYearly, legacy.yearly),
  };
}
