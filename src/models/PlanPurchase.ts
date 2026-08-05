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
/**
 * An addon pack bought in the same checkout as the plan.
 *
 * The pack's name, credit quantity and unit price are copied in rather than
 * referenced, because this row is what a receipt is rendered from months later
 * — by which time the pack may have been renamed, repriced, or deactivated. A
 * receipt has to say what was actually sold on the day.
 */
const purchasedPackSchema = new Schema(
  {
    addonPackId: { type: Schema.Types.ObjectId, ref: "AddonPack", required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    /** Credits in one pack. Total credited is this times `packs`. */
    quantity: { type: Number, required: true },
    /** How many of this pack were bought. */
    packs: { type: Number, required: true, min: 1 },
    /** Price of a single pack at purchase time, before any coupon. */
    unitAmount: { type: Number, required: true },
  },
  { _id: false }
);

const planPurchaseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planSlug: { type: String, required: true },
    cycle: { type: String, enum: BILLING_CYCLES, required: true },

    /**
     * Addon packs bought alongside the plan in one checkout.
     *
     * Empty for a plain plan purchase. Credited by the same idempotent claim
     * that activates the plan period, so a webhook racing the client-side
     * verify call cannot credit the packs twice.
     */
    addons: { type: [purchasedPackSchema], default: [] },
    /** The plan's own share of `amount`, before any coupon. Kept so a receipt can itemise. */
    planAmount: { type: Number, default: 0 },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, default: "" },
    /** Final charged amount, after any coupon discount. */
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
    /** The code applied, if any — kept for the order history even after the coupon itself is deactivated. */
    couponCode: { type: String, default: "" },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    /**
     * The receipt's number, assigned when the payment is credited — never at
     * order creation, so an abandoned checkout doesn't consume one and leave a
     * gap in the monthly sequence. Empty until then.
     */
    invoiceNumber: { type: String, default: "", index: true },
    /** When the receipt was issued. Distinct from `createdAt`, which is when checkout started. */
    invoicedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const PlanPurchase = mongoose.model("PlanPurchase", planPurchaseSchema);
export type { BillingCycle };
