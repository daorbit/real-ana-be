import mongoose, { Schema } from "mongoose";

const statusDaySchema = new Schema(
  {
    component: { type: String, required: true },
    day: { type: String, required: true },
    checks: { type: Number, default: 0 },
    degraded: { type: Number, default: 0 },
    outage: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

statusDaySchema.index({ component: 1, day: 1 }, { unique: true });
statusDaySchema.index({ day: 1 });
statusDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StatusDay = mongoose.model("StatusDay", statusDaySchema);
