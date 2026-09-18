import mongoose, { Schema } from "mongoose";

const pushSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    userAgent: { type: String, default: "" },
    lastSuccessAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
