import mongoose, { Schema } from "mongoose";
import { placedSchema } from "../../workspace/models/placed.js";

export const DASHBOARD_RANGES = ["24h", "7d", "30d"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

const dashboardSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    template: { type: String, default: "blank" },
    range: { type: String, enum: DASHBOARD_RANGES, default: "7d" },
    layout: { type: [placedSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const Dashboard = mongoose.model("Dashboard", dashboardSchema);
