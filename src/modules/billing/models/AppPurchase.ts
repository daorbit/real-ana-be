import mongoose, { Schema } from "mongoose";
import { CURRENCIES, DEFAULT_CURRENCY } from "../currency.js";

const appPurchaseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    appId: { type: String, required: true },
    gateway: { type: String, enum: ["razorpay", "cashfree", "coupon"], default: "razorpay", index: true },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    cashfreeOrderId: { type: String, unique: true, sparse: true },
    razorpayPaymentId: { type: String, default: "" },
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCIES, default: DEFAULT_CURRENCY },
    couponCode: { type: String, default: "" },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    invoiceNumber: { type: String, default: "", index: true },
    invoicedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const AppPurchase = mongoose.model("AppPurchase", appPurchaseSchema);
