import mongoose, { Schema } from "mongoose";

const insightSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, required: true },
    tone: { type: String, enum: ["good", "bad", "info"], required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    dimension: { type: String, default: "" },
    key: { type: String, default: "" },
    current: { type: Number, default: 0 },
    previous: { type: Number, default: 0 },
    delta: { type: Number, default: null },
    unit: { type: String, default: "" },
    score: { type: Number, default: 0 },
  },
  { _id: false },
);

const insightDigestSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    weekStart: { type: Date, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    summary: { type: String, default: "" },
    action: { type: String, default: "" },
    visitors: { type: Number, default: 0 },
    previousVisitors: { type: Number, default: 0 },
    insights: { type: [insightSchema], default: [] },
    generatedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

insightDigestSchema.index({ workspaceId: 1, weekStart: -1 }, { unique: true });

export const InsightDigest = mongoose.model("InsightDigest", insightDigestSchema);
