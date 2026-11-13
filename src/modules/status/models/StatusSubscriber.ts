import mongoose, { Schema } from "mongoose";

const statusSubscriberSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

statusSubscriberSchema.index({ email: 1 }, { unique: true });
statusSubscriberSchema.index({ token: 1 }, { unique: true });
statusSubscriberSchema.index({ confirmedAt: 1, _id: 1 });

export const StatusSubscriber = mongoose.model("StatusSubscriber", statusSubscriberSchema);
