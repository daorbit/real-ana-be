import mongoose, { Schema } from "mongoose";

/**
 * One historical snapshot of a competitor page.
 *
 * The `Competitor` document keeps the latest snapshot inline, which is all a
 * side-by-side comparison needs. This collection exists for the question that
 * one cannot answer: whether a competitor is improving faster than you are.
 * A single score at a single moment says nothing about direction.
 *
 * Deliberately narrow: only the score and the handful of numbers a trend line
 * is drawn from, never the full snapshot. Storing every past copy of someone
 * else's page would be a large amount of storage for a question nobody asks,
 * and the latest full snapshot already lives on the parent document.
 */
const competitorSnapshotSchema = new Schema({
  competitorId: {
    type: Schema.Types.ObjectId,
    ref: "Competitor",
    required: true,
    index: true,
  },
  /** Denormalised so a site's whole trend loads without joining via competitors. */
  siteId: { type: String, required: true, index: true },

  score: { type: Number, required: true },
  wordCount: { type: Number, default: 0 },
  responseTimeMs: { type: Number, default: 0 },
  pageBytes: { type: Number, default: 0 },
  internalLinks: { type: Number, default: 0 },
  schemaErrors: { type: Number, default: 0 },
  /** Status code of that fetch, so a 500 does not read as a real score drop. */
  statusCode: { type: Number, default: 200 },

  takenAt: { type: Date, default: Date.now, index: true },
});

// Every read is "this competitor's history, newest first".
competitorSnapshotSchema.index({ competitorId: 1, takenAt: -1 });

export const CompetitorSnapshot = mongoose.model(
  "CompetitorSnapshot",
  competitorSnapshotSchema
);
