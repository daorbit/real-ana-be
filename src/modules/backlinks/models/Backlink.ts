import mongoose, { Schema } from "mongoose";

export const LINK_RELS = ["follow", "nofollow", "ugc", "sponsored"] as const;
export const BACKLINK_ORIGINS = ["referral", "manual", "index", "scan"] as const;
export const BACKLINK_STATUSES = ["pending", "live", "unverified", "lost", "page-gone", "unreachable"] as const;

export type BacklinkStatus = (typeof BACKLINK_STATUSES)[number];

const backlinkSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, index: true },
    sourceUrl: { type: String, required: true },
    sourceDomain: { type: String, required: true },
    targetUrl: { type: String, default: "" },
    anchorText: { type: String, default: "" },
    rel: { type: String, enum: LINK_RELS, default: "follow" },
    isImage: { type: Boolean, default: false },
    origin: { type: String, enum: BACKLINK_ORIGINS, default: "manual" },
    status: { type: String, enum: BACKLINK_STATUSES, default: "pending" },
    httpStatus: { type: Number, default: null },
    authority: { type: Number, default: null },
    referralVisits: { type: Number, default: 0 },
    lastReferralAt: { type: Date, default: null },
    lastLiveAt: { type: Date, default: null },
    lostAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

backlinkSchema.index({ siteId: 1, sourceUrl: 1 }, { unique: true });
backlinkSchema.index({ lastCheckedAt: 1 });

export const Backlink = mongoose.model("Backlink", backlinkSchema);
