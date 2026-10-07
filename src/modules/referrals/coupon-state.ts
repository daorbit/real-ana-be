import { Coupon } from "../billing/models/Coupon.js";

export type RewardCouponState = "ready" | "used" | "expired" | "off";

export type RewardCoupon = {
  percentOff: number;
  uses: number;
  active: boolean;
  expiresAt: Date | null;
  usedAt: Date | null;
  usedFor: string;
  state: RewardCouponState;
};

function stateOf(c: { uses: number; active: boolean; expiresAt: Date | null }): RewardCouponState {
  if (c.uses > 0) return "used";
  if (!c.active) return "off";
  if (c.expiresAt && c.expiresAt.getTime() < Date.now()) return "expired";
  return "ready";
}

export async function rewardCouponsById(ids: unknown[]): Promise<Map<string, RewardCoupon>> {
  const present = ids.filter(Boolean);
  if (!present.length) return new Map();
  const coupons = await Coupon.find({ _id: { $in: present } })
    .select("percentOff uses expiresAt active usedAt usedFor updatedAt")
    .lean();

  return new Map(
    coupons.map((c) => {
      const uses = c.uses ?? 0;
      const base = {
        percentOff: c.percentOff,
        uses,
        active: Boolean(c.active),
        expiresAt: (c.expiresAt as Date | null) ?? null,
        usedAt: uses > 0 ? ((c.usedAt as Date | null) ?? (c.updatedAt as Date | null) ?? null) : null,
        usedFor: c.usedFor ?? "",
      };
      return [String(c._id), { ...base, state: stateOf(base) }];
    }),
  );
}
