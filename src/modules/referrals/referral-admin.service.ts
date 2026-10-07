import { Types } from "mongoose";
import { Referral, REFERRAL_STATUSES, type ReferralStatus } from "./models/Referral.js";
import { ReferralCode } from "./models/ReferralCode.js";
import { Coupon } from "../billing/models/Coupon.js";
import { User } from "../identity/models/User.js";

const PAGE_SIZE = 20;
const TOP_LIMIT = 20;

type UserRef = { id: string; name: string; email: string };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function usersById(ids: unknown[]): Promise<Map<string, UserRef>> {
  const unique = [...new Set(ids.map(String))];
  const users = await User.find({ _id: { $in: unique } }).select("name email");
  return new Map(users.map((u) => [u.id, { id: u.id, name: u.name, email: u.email }]));
}

async function couponsById(ids: unknown[]) {
  const present = ids.filter(Boolean);
  if (!present.length) return new Map<string, { uses: number; expiresAt: Date | null; active: boolean }>();
  const coupons = await Coupon.find({ _id: { $in: present } }).select("uses expiresAt active");
  return new Map(
    coupons.map((c) => [c.id, { uses: c.uses ?? 0, expiresAt: (c.expiresAt as Date) ?? null, active: Boolean(c.active) }]),
  );
}

export async function listReferrals(query: { q?: string; status?: string; page?: number }) {
  const page = Math.max(1, Number(query.page) || 1);
  const filter: Record<string, unknown> = {};
  if (REFERRAL_STATUSES.includes(query.status as ReferralStatus)) filter.status = query.status;

  const q = String(query.q ?? "").trim();
  if (q) {
    const matched = await User.find({
      $or: [
        { email: { $regex: escapeRegex(q), $options: "i" } },
        { name: { $regex: escapeRegex(q), $options: "i" } },
      ],
    }).select("_id").limit(200);
    const ids = matched.map((u) => u._id);
    filter.$or = [{ referrerId: { $in: ids } }, { refereeId: { $in: ids } }, { code: q.toUpperCase() }];
  }

  const [rows, total] = await Promise.all([
    Referral.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
    Referral.countDocuments(filter),
  ]);

  const [users, coupons] = await Promise.all([
    usersById(rows.flatMap((r) => [r.referrerId, r.refereeId])),
    couponsById(rows.map((r) => r.couponId)),
  ]);

  return {
    referrals: rows.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      flagged: Boolean(r.flagged),
      createdAt: r.get("createdAt"),
      rewardedAt: r.rewardedAt,
      referrer: users.get(String(r.referrerId)) ?? null,
      referee: users.get(String(r.refereeId)) ?? null,
      coupon: r.couponCode
        ? { code: r.couponCode, ...(coupons.get(String(r.couponId)) ?? { uses: 0, expiresAt: null, active: false }) }
        : null,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function referralOverview() {
  const [byStatus, flagged, redeemed, codes] = await Promise.all([
    Referral.aggregate<{ _id: ReferralStatus; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Referral.countDocuments({ flagged: true, status: "pending" }),
    Coupon.countDocuments({ ownerId: { $ne: null }, uses: { $gt: 0 } }),
    ReferralCode.countDocuments(),
  ]);
  const counts = Object.fromEntries(REFERRAL_STATUSES.map((s) => [s, 0])) as Record<ReferralStatus, number>;
  for (const row of byStatus) counts[row._id] = row.n;
  const total = REFERRAL_STATUSES.reduce((sum, s) => sum + counts[s], 0);
  return { total, ...counts, flagged, couponsRedeemed: redeemed, codes };
}

export async function topReferrers() {
  const rows = await Referral.aggregate<{ _id: Types.ObjectId; total: number; rewarded: number }>([
    { $group: { _id: "$referrerId", total: { $sum: 1 }, rewarded: { $sum: { $cond: [{ $eq: ["$status", "rewarded"] }, 1, 0] } } } },
    { $sort: { total: -1 } },
    { $limit: TOP_LIMIT },
  ]);
  const [users, codes] = await Promise.all([
    usersById(rows.map((r) => r._id)),
    ReferralCode.find({ userId: { $in: rows.map((r) => r._id) } }).select("userId code active"),
  ]);
  const codeByUser = new Map(codes.map((c) => [String(c.userId), { code: c.code, active: Boolean(c.active) }]));

  return rows.map((r) => ({
    user: users.get(String(r._id)) ?? null,
    total: r.total,
    rewarded: r.rewarded,
    code: codeByUser.get(String(r._id)) ?? null,
  }));
}

export async function rejectReferral(id: string) {
  const updated = await Referral.findOneAndUpdate(
    { _id: id, status: "pending" },
    { $set: { status: "rejected" } },
    { new: true },
  );
  return updated ? { ok: true as const } : { ok: false as const, error: "only pending referrals can be rejected" };
}

export async function revokeReferral(id: string) {
  const updated = await Referral.findOneAndUpdate(
    { _id: id, status: "rewarded" },
    { $set: { status: "revoked" } },
    { new: true },
  );
  if (!updated) return { ok: false as const, error: "only rewarded referrals can be revoked" };
  if (updated.couponId) await Coupon.updateOne({ _id: updated.couponId }, { $set: { active: false } });
  return { ok: true as const };
}

export async function setCodeActive(userId: string, active: boolean) {
  const updated = await ReferralCode.findOneAndUpdate({ userId }, { $set: { active } }, { new: true });
  return updated ? { ok: true as const, active: Boolean(updated.active) } : { ok: false as const, error: "this user has no referral code" };
}

export async function myReferralSummary(userId: string) {
  const rows = await Referral.find({ referrerId: userId }).sort({ createdAt: -1 }).limit(100);
  const [users, coupons] = await Promise.all([
    usersById(rows.map((r) => r.refereeId)),
    couponsById(rows.map((r) => r.couponId)),
  ]);

  return rows.map((r) => {
    const coupon = coupons.get(String(r.couponId));
    return {
      id: r.id,
      name: maskName(users.get(String(r.refereeId))?.name ?? ""),
      status: r.status === "rejected" || r.status === "revoked" ? "closed" : r.status,
      createdAt: r.get("createdAt"),
      coupon:
        r.status === "rewarded" && coupon
          ? { code: r.couponCode, used: coupon.uses > 0, expiresAt: coupon.expiresAt }
          : null,
    };
  });
}

function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "New user";
  const first = parts[0];
  const last = parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : "";
  return `${first}${last}`;
}
