import mongoose, { Schema } from "mongoose";

/**
 * A site-wide crawl.
 *
 * Kept separate from `SeoReport`, which is deliberately one URL and one audit.
 * A crawl covers many pages and stores summaries rather than full audits, so
 * folding the two together would make most fields conditional on which kind of
 * report you were looking at.
 */
const crawlReportSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    /** Origin crawled, e.g. https://example.com */
    origin: { type: String, required: true },
    /** Average per-page health across the crawl, 0-100. */
    score: { type: Number, default: 0 },
    /** Denormalised so the history list renders without unpacking `data`. */
    crawled: { type: Number, default: 0 },
    discovered: { type: Number, default: 0 },
    findingCount: { type: Number, default: 0 },
    criticalCount: { type: Number, default: 0 },
    /** The full `CrawlResult`. */
    data: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

crawlReportSchema.index({ siteId: 1, createdAt: -1 });

export const CrawlReport = mongoose.model("CrawlReport", crawlReportSchema);
