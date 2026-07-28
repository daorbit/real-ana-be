import mongoose, { Schema } from "mongoose";
import { BILLING_CYCLES, type BillingCycle } from "./Subscription.js";
import { CURRENCIES, DEFAULT_CURRENCY } from "../lib/currency.js";

/**
 * One Razorpay order for a plan period (new subscription or a renewal).
 * Created when checkout starts, marked `paid` once the webhook confirms
 * `order.paid` (or the client-side verify call checks out) — the plan is only
 * activated once, guarded by this row's `status`, so a retried webhook can't
 * double-apply a renewal.
 */
const planPurchaseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planSlug: { type: String, required: true },
    cycle: { type: String, enum: BILLING_CYCLES, required: true },
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

export const PlanPurchase = mongoose.model("PlanPurchase", planPurchaseSchema);
export type { BillingCycle };
