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
    /**
     * The workspace whose credits these are. Credits live on a workspace's
     * subscription, so a purchase has to name one. Null only on rows written
     * before per-workspace billing — see `PlanPurchase.workspaceId`.
     */
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    addonPackId: { type: Schema.Types.ObjectId, ref: "AddonPack", required: true },
    /**
     * How many of the pack were bought. Defaults to 1 so rows written before
     * multi-pack checkout existed still credit correctly.
     */
    packs: { type: Number, default: 1, min: 1 },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, default: "" },
    /** Final charged amount, after any coupon discount. */
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
    /** The code applied, if any — kept for the order history even after the coupon itself is deactivated. */
    couponCode: { type: String, default: "" },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    /** See `PlanPurchase` — assigned at credit time, not at checkout start. */
    invoiceNumber: { type: String, default: "", index: true },
    invoicedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const AddonPurchase = mongoose.model("AddonPurchase", addonPurchaseSchema);
