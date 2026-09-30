import mongoose, { Schema } from "mongoose";
import { DASHBOARD_RANGES } from "./Dashboard.js";

export const EMBED_THEMES = ["auto", "light", "dark"] as const;

const embedSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true },
    widget: { type: String, required: true },
    range: { type: String, enum: DASHBOARD_RANGES, default: "30d" },
    theme: { type: String, enum: EMBED_THEMES, default: "auto" },
    sites: { type: [String], default: [] },
    token: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const Embed = mongoose.model("Embed", embedSchema);
