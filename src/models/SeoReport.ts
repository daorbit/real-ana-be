import mongoose, { Schema } from "mongoose";

/**
 * A stored SEO audit for one URL of one site.
 *
 * The report body is kept as a loose subdocument on purpose: it mirrors
 * whatever `seo-core` produced at the time, and pinning it to a strict schema
 * would mean a migration every time an audit field is added. The typed shape
 * lives in `SeoReportData`.
 *
 * Reports double as the cache — a repeat analysis of the same URL inside the
 * freshness window reuses the last one rather than spending another PageSpeed
 * quota unit — and as the history the dashboard charts over time.
 */
const seoReportSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, index: true }, // public tracking key of the Site
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    url: { type: String, required: true },
    score: { type: Number, default: 0 },
    /** Denormalised so the history list renders without unpacking every report. */
    scores: {
      performance: { type: Number, default: null },
      accessibility: { type: Number, default: null },
      bestPractices: { type: Number, default: null },
      seo: { type: Number, default: null },
    },
    issueCount: { type: Number, default: 0 },
    criticalCount: { type: Number, default: 0 },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

// The two reads this collection serves: the newest report for a URL (cache
// lookup) and a site's history newest-first (the history list).
seoReportSchema.index({ siteId: 1, url: 1, createdAt: -1 });
seoReportSchema.index({ workspaceId: 1, createdAt: -1 });

export const SeoReport = mongoose.model("SeoReport", seoReportSchema);
