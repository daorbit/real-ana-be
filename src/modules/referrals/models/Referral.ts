import mongoose, { Schema } from "mongoose";

export const REFERRAL_STATUSES = ["pending", "rewarded", "rejected", "revoked"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

const referralSchema = new Schema(
  {
    referrerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    refereeId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    code: { type: String, required: true },
    status: { type: String, enum: REFERRAL_STATUSES, required: true, default: "pending" },
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", default: null },
    couponCode: { type: String, default: "" },
    rewardedAt: { type: Date, default: null },
    ipHash: { type: String, default: "" },
    flagged: { type: Boolean, default: false },
  },
  { timestamps: true }
);

referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ createdAt: -1 });

export const Referral = mongoose.model("Referral", referralSchema);
