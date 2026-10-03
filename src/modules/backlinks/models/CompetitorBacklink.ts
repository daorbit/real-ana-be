import mongoose, { Schema } from "mongoose";
import { LINK_RELS } from "./Backlink.js";

const competitorBacklinkSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, index: true },
    competitorId: { type: Schema.Types.ObjectId, ref: "Competitor", required: true, index: true },
    sourceUrl: { type: String, required: true },
    sourceDomain: { type: String, required: true },
    targetUrl: { type: String, default: "" },
    anchorText: { type: String, default: "" },
    rel: { type: String, enum: LINK_RELS, default: "follow" },
    isImage: { type: Boolean, default: false },
    origin: { type: String, enum: ["index", "scan"], default: "scan" },
    status: { type: String, enum: ["live", "lost"], default: "live" },
    authority: { type: Number, default: null },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

competitorBacklinkSchema.index({ competitorId: 1, sourceUrl: 1 }, { unique: true });

export const CompetitorBacklink = mongoose.model("CompetitorBacklink", competitorBacklinkSchema);
