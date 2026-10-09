import mongoose, { Schema } from "mongoose";

export const TARGET_METRICS = [
  "visitors",
  "pageviews",
  "sessions",
  "formSubmissions",
  "searchPosition",
] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

export const TARGET_PERIODS = ["month", "quarter"] as const;
export type TargetPeriod = (typeof TARGET_PERIODS)[number];

const goalTargetSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true },
    metric: { type: String, enum: TARGET_METRICS, required: true },
    target: { type: Number, required: true },
    period: { type: String, enum: TARGET_PERIODS, default: "month" },
    siteId: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const GoalTarget = mongoose.model("GoalTarget", goalTargetSchema);
