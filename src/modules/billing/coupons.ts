import { Coupon } from "./models/Coupon.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";
import { resolveOrbitPlan } from "../orbit/orbit-plans.catalog.js";

/**
 * Look up a coupon by code and apply its discount to `amount` (paise).
 * Returns the original amount unchanged when no code is given — checkout
 * flows call this unconditionally rather than branching on "was a code
 * entered", so an empty/absent code is just a no-op discount.
 */
export async function applyCoupon(
  amount: number,
  code: string | undefined,
  userId?: string
): Promise<{ amount: number; error?: string; coupon?: { code: string; percentOff: number } }> {
  const raw = String(code ?? "").trim().toUpperCase();
  if (!raw) return { amount };

  const coupon = await Coupon.findOne({ code: raw });
  if (!coupon || !coupon.active) return { amount, error: "coupon not found" };
  if (coupon.ownerId && String(coupon.ownerId) !== String(userId ?? ""))
    return { amount, error: "coupon not found" };
  if (coupon.expiresAt && (coupon.expiresAt as Date).getTime() < Date.now())
    return { amount, error: "coupon has expired" };
  if (coupon.maxUses && (coupon.uses ?? 0) >= coupon.maxUses)
    return { amount, error: "coupon has already been used" };

  const percentOff = coupon.percentOff as number;
  // Razorpay orders round to whole paise; floor rather than round so a
  // discount never charges a customer more than the stated percentage off.
  const discounted = Math.floor((amount * (100 - percentOff)) / 100);
  return { amount: discounted, coupon: { code: raw, percentOff } };
}

export async function redeemCoupon(code: unknown, usedFor = ""): Promise<void> {
  const raw = String(code ?? "").trim().toUpperCase();
  if (!raw) return;
  await Coupon.updateOne(
    { code: raw },
    { $inc: { uses: 1 }, $set: { usedAt: new Date(), ...(usedFor ? { usedFor } : {}) } },
  );
}

export function planPurchaseLabel(ladder: unknown, slug: string): string {
  const name = ladder === "orbit" ? resolveOrbitPlan(slug).name : (getPlanCatalogEntry(slug)?.name ?? slug);
  return `${name} plan`;
}
