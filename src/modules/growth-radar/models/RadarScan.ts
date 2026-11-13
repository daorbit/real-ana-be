import mongoose, { Schema } from "mongoose";

const RETENTION_SECONDS = 400 * 24 * 60 * 60;

const sourceSchema = new Schema(
  {
    id: { type: String, required: true },
    state: { type: String, enum: ["ready", "not_connected", "stale", "error"], required: true },
    detail: { type: String, default: "" },
    freshAt: { type: Date, default: null },
  },
  { _id: false },
);

const detectorRunSchema = new Schema(
  {
    id: { type: String, required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ["ran", "skipped", "failed", "off"], required: true },
    reason: { type: String, default: "" },
    found: { type: Number, default: 0 },
  },
  { _id: false },
);

const radarScanSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    trigger: { type: String, enum: ["schedule", "manual", "first"], required: true },
    status: { type: String, enum: ["ok", "partial", "failed"], required: true },
    error: { type: String, default: "" },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    sources: { type: [sourceSchema], default: [] },
    detectors: { type: [detectorRunSchema], default: [] },
    found: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    reopened: { type: Number, default: 0 },
  },
  { timestamps: false },
);

radarScanSchema.index({ workspaceId: 1, startedAt: -1 });
radarScanSchema.index({ startedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const RadarScan = mongoose.model("RadarScan", radarScanSchema);
