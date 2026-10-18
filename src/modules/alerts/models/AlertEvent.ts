import mongoose, { Schema } from "mongoose";
import { ALERT_RULES } from "../rules.js";

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

const alertEventSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    rule: { type: String, enum: ALERT_RULES, required: true },
    key: { type: String, default: "" },
    title: { type: String, required: true },
    summary: { type: String, default: "" },
    siteId: { type: String, default: "" },
    link: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

alertEventSchema.index({ workspaceId: 1, createdAt: -1 });
alertEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const AlertEvent = mongoose.model("AlertEvent", alertEventSchema);
