import mongoose, { Schema } from "mongoose";
import { CURRENCIES, DEFAULT_CURRENCY } from "../lib/currency.js";

/**
 * One Razorpay order for an addon pack. Created when the user starts checkout,
 * marked `paid` once the webhook confirms `order.paid` (or the client-side
 * verify call checks out) — the credits in `Subscription` are only incremented
 * once, guarded by this row's `status`, so a retried webhook can't double-credit.
 */
const addonPurchaseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    addonPackId: { type: Schema.Types.ObjectId, ref: "AddonPack", required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, default: "" },
    /** Final charged amount, after any coupon discount. */
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
    /** The code applied, if any — kept for the order history even after the coupon itself is deactivated. */
    couponCode: { type: String, default: "" },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
  },
  { timestamps: true }
);

export const AddonPurchase = mongoose.model("AddonPurchase", addonPurchaseSchema);
