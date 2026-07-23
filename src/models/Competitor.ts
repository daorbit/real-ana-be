import mongoose, { Schema } from "mongoose";

/**
 * A competitor URL tracked against one of the workspace's sites.
 *
 * The latest snapshot is stored on the document rather than as history: a
 * comparison answers "how do we look against them right now", and keeping every
 * past snapshot of someone else's site is storage spent on a question nobody
 * asks.
 */
const competitorSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, index: true },
    /** Display name, defaulted from the hostname. */
    label: { type: String, default: "" },
    url: { type: String, required: true },
    /** Latest `CompareSnapshot`. Null until the first successful fetch. */
    snapshot: { type: Schema.Types.Mixed, default: null },
    lastCheckedAt: { type: Date, default: null },
    /** Why the last attempt failed, when it did. Cleared on success. */
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

// One row per URL per site, and the list is always read per site.
competitorSchema.index({ siteId: 1, url: 1 }, { unique: true });

export const Competitor = mongoose.model("Competitor", competitorSchema);
