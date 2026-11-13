import mongoose, { Schema } from "mongoose";

export const OPPORTUNITY_STATUSES = ["open", "planned", "investigating", "resolved", "dismissed", "archived"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const ACTIVE_STATUSES: OpportunityStatus[] = ["open", "planned", "investigating"];
export const CLOSED_STATUSES: OpportunityStatus[] = ["resolved", "dismissed", "archived"];

const factorSchema = new Schema(
  { level: { type: String, enum: ["high", "medium", "low"], required: true }, reason: { type: String, default: "" } },
  { _id: false },
);

const metricSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    current: { type: Number, required: true },
    previous: { type: Number, default: null },
    unit: { type: String, enum: ["count", "percent"], required: true },
  },
  { _id: false },
);

const noteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: true },
);

const activitySchema = new Schema(
  {
    at: { type: Date, default: () => new Date() },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    kind: { type: String, required: true },
    detail: { type: String, default: "" },
  },
  { _id: false },
);

const actionSchema = new Schema(
  {
    description: { type: String, required: true },
    otherChanges: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startedAt: { type: Date, required: true },
    followUpDays: { type: Number, required: true },
    followUpEndsAt: { type: Date, required: true },
    metric: { type: String, required: true },
    baseline: { type: Number, required: true },
    latest: {
      value: { type: Number },
      periodStart: { type: Date },
      periodEnd: { type: Date },
    },
  },
  { _id: false },
);

const radarOpportunitySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    fingerprint: { type: String, required: true },
    detector: { type: String, required: true },
    detectorVersion: { type: Number, required: true },
    category: { type: String, required: true },
    status: { type: String, enum: OPPORTUNITY_STATUSES, default: "open" },
    priority: { type: String, enum: ["high", "medium", "low"], required: true },
    priorityRank: { type: Number, required: true },
    priorityReason: { type: String, default: "" },
    factors: {
      impact: { type: factorSchema, required: true },
      confidence: { type: factorSchema, required: true },
      urgency: { type: factorSchema, required: true },
      effort: { type: factorSchema, required: true },
    },
    entity: {
      type: { type: String, required: true },
      key: { type: String, default: "" },
      label: { type: String, default: "" },
    },
    title: { type: String, required: true },
    summary: { type: String, default: "" },
    aiSummary: { type: String, default: "" },
    whyItMatters: { type: String, default: "" },
    nextSteps: { type: [String], default: [] },
    limitations: { type: [String], default: [] },
    metrics: { type: [metricSchema], default: [] },
    primaryMetric: { type: String, required: true },
    period: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
      previousStart: { type: Date, default: null },
      previousEnd: { type: Date, default: null },
      days: { type: Number, required: true },
      includesToday: { type: Boolean, default: false },
    },
    sampleSize: { type: Number, default: 0 },
    sources: { type: [String], default: [] },
    detected: { type: Boolean, default: true },
    firstDetectedAt: { type: Date, required: true },
    lastDetectedAt: { type: Date, required: true },
    lastScanId: { type: Schema.Types.ObjectId, ref: "RadarScan", default: null },
    snoozedUntil: { type: Date, default: null },
    dismissReason: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    assigneeId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: [noteSchema], default: [] },
    activity: { type: [activitySchema], default: [] },
    action: { type: actionSchema, default: null },
  },
  { timestamps: true },
);

radarOpportunitySchema.index({ workspaceId: 1, fingerprint: 1 }, { unique: true });
radarOpportunitySchema.index({ workspaceId: 1, status: 1, priorityRank: -1, lastDetectedAt: -1 });
radarOpportunitySchema.index({ workspaceId: 1, status: 1, closedAt: -1 });

export const RadarOpportunity = mongoose.model("RadarOpportunity", radarOpportunitySchema);
