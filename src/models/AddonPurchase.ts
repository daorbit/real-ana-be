import mongoose, { Schema } from "mongoose";

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
    amount: { type: Number, required: true },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
  },
  { timestamps: true }
);

export const AddonPurchase = mongoose.model("AddonPurchase", addonPurchaseSchema);
