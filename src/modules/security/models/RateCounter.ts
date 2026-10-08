import mongoose, { Schema } from "mongoose";

const rateCounterSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

rateCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateCounter = mongoose.model("RateCounter", rateCounterSchema);
