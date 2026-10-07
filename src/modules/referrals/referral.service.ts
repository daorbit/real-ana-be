import { createHash } from "crypto";
import { Referral } from "./models/Referral.js";
import { ReferralCode } from "./models/ReferralCode.js";
import { getReferralSettings } from "./settings.js";
import { normalizeCode, randomToken } from "./codes.js";
import { Coupon } from "../billing/models/Coupon.js";
import { User } from "../identity/models/User.js";
import { emitTo } from "../notifications/notify.service.js";
import { mailConfigured, sendOne } from "../../infra/mail/mailer.js";

const CLAIM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ClaimResult = { ok: true } | { ok: false; error: string };

export function hashIp(ip: string): string {
  return ip ? createHash("sha256").update(`referral:${ip}`).digest("hex").slice(0, 32) : "";
}

export async function claimReferral(userId: string, rawCode: unknown, ip: string): Promise<ClaimResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: "referral code required" };

  const [settings, user, owner, existing] = await Promise.all([
    getReferralSettings(),
    User.findById(userId).select("createdAt"),
    ReferralCode.findOne({ code }),
    Referral.findOne({ refereeId: userId }).select("_id"),
  ]);

  if (!settings.enabled) return { ok: false, error: "the referral program is paused" };
  if (!user) return { ok: false, error: "user not found" };
  if (existing) return { ok: false, error: "this account was already referred" };
  if (!owner || !owner.active) return { ok: false, error: "referral code not found" };
  if (String(owner.userId) === String(userId)) return { ok: false, error: "you cannot refer yourself" };

  const createdAt = new Date(user.get("createdAt") as Date).getTime();
  if (Date.now() - createdAt > CLAIM_WINDOW_MS)
    return { ok: false, error: "referral codes only apply to new accounts" };

  const ipHash = hashIp(ip);
  const sameIp = ipHash
    ? await Referral.exists({ referrerId: owner.userId, ipHash })
    : null;

  try {
    const referral = await Referral.create({
      referrerId: owner.userId,
      refereeId: userId,
      code,
      ipHash,
      flagged: Boolean(sameIp),
    });
    if (settings.qualifyOn === "signup" && !referral.flagged) {
      await rewardReferral(String(referral._id)).catch((e) =>
        console.error("[referrals] signup reward failed:", (e as Error).message),
      );
    }
  } catch (e) {
    if ((e as Error).message?.includes("E11000")) return { ok: false, error: "this account was already referred" };
    throw e;
  }

  return { ok: true };
}

export async function qualifyReferralOnPayment(userId: string): Promise<void> {
  try {
    const referral = await Referral.findOne({ refereeId: userId, status: "pending", flagged: false }).select("_id");
    if (!referral) return;
    const settings = await getReferralSettings();
    if (settings.enabled) await rewardReferral(String(referral._id));
  } catch (e) {
    console.error("[referrals] payment qualification failed:", (e as Error).message);
  }
}

export async function rewardReferral(
  referralId: string,
  options: { bypassCap?: boolean } = {}
): Promise<{ ok: true; couponCode: string } | { ok: false; error: string }> {
  const [referral, settings] = await Promise.all([
    Referral.findById(referralId),
    getReferralSettings(),
  ]);
  if (!referral) return { ok: false, error: "referral not found" };
  if (referral.status !== "pending") return { ok: false, error: `referral is already ${referral.status}` };

  if (!options.bypassCap && settings.maxRewardsPerUser > 0) {
    const rewarded = await Referral.countDocuments({ referrerId: referral.referrerId, status: "rewarded" });
    if (rewarded >= settings.maxRewardsPerUser) return { ok: false, error: "reward cap reached for this referrer" };
  }

  const coupon = await Coupon.create({
    code: `REF-${randomToken(8)}`,
    percentOff: settings.rewardPercentOff,
    expiresAt: new Date(Date.now() + settings.rewardValidDays * 24 * 60 * 60 * 1000),
    ownerId: referral.referrerId,
    maxUses: 1,
  });

  const claimed = await Referral.findOneAndUpdate(
    { _id: referral._id, status: "pending" },
    { $set: { status: "rewarded", couponId: coupon._id, couponCode: coupon.code, rewardedAt: new Date() } },
  );
  if (!claimed) {
    await coupon.deleteOne();
    return { ok: false, error: "referral changed while rewarding" };
  }

  void notifyReward(String(referral.referrerId), coupon.code, settings.rewardPercentOff, coupon.expiresAt as Date);
  return { ok: true, couponCode: coupon.code };
}

async function notifyReward(userId: string, couponCode: string, percentOff: number, expiresAt: Date) {
  await emitTo({
    userId,
    type: "referral.rewarded",
    data: { couponCode, percentOff: String(percentOff) },
    link: "/app/billing?tab=referrals",
  });

  if (!mailConfigured()) return;
  try {
    const user = await User.findById(userId).select("email name");
    if (!user?.email) return;
    const until = expiresAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
    await sendOne(
      { email: user.email, name: user.name },
      `You earned ${percentOff}% off Quantalog`,
      `Hi ${user.name},\n\nSomeone you invited just joined Quantalog. As a thank you, here is ${percentOff}% off your next purchase.\n\nCoupon: ${couponCode}\nValid until: ${until}\n\nUse it at checkout on the Billing page. It works once, on your account only.`,
    );
  } catch (e) {
    console.error("[referrals] reward email failed:", (e as Error).message);
  }
}
