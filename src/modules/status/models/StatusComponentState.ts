import mongoose, { Schema } from "mongoose";

const statusComponentStateSchema = new Schema(
  {
    component: { type: String, required: true },
    state: { type: String, enum: ["operational", "degraded", "outage"], default: "operational" },
    failures: { type: Number, default: 0 },
    latencyMs: { type: Number, default: null },
    message: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    lastOkAt: { type: Date, default: null },
  },
  { timestamps: false },
);

statusComponentStateSchema.index({ component: 1 }, { unique: true });

export const StatusComponentState = mongoose.model("StatusComponentState", statusComponentStateSchema);
