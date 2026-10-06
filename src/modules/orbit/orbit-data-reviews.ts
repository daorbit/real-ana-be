import { GoogleLocation } from "../reviews/models/GoogleLocation.js";
import { GoogleReview } from "../reviews/models/GoogleReview.js";

const WINDOW_DAYS = 30;
const RECENT_REVIEWS = 3;
const MAX_COMMENT = 160;

async function reviewsSummary(workspaceId: string, since: Date): Promise<string> {
  const [locations, recent] = await Promise.all([
    GoogleLocation.find({ workspaceId, status: "connected" }).select("title averageRating totalReviewCount").limit(3).lean(),
    GoogleReview.find({ workspaceId, deletedAt: null, reviewCreatedAt: { $gte: since } })
      .sort({ reviewCreatedAt: -1 })
      .limit(50)
      .select("rating comment replyComment")
      .lean(),
  ]);

  if (!locations.length) return "";

  const lines = locations.map(
    (l) => `Google reviews for ${l.title || "a location"}: ${l.averageRating} average from ${l.totalReviewCount} reviews.`,
  );

  if (recent.length) {
    const average = recent.reduce((sum, r) => sum + r.rating, 0) / recent.length;
    const unanswered = recent.filter((r) => !r.replyComment).length;
    lines.push(
      `Last ${WINDOW_DAYS} days: ${recent.length} new reviews, ${average.toFixed(1)} average, ${unanswered} without a reply.`,
    );
    for (const r of recent.slice(0, RECENT_REVIEWS)) {
      if (r.comment) lines.push(`  - ${r.rating} stars: "${r.comment.slice(0, MAX_COMMENT)}"`);
    }
  }
  return lines.join("\n");
}

export function reviewsSummaryFor(workspaceId: string): Promise<string> {
  return reviewsSummary(workspaceId, new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000));
}
