import { Types } from "mongoose";
import { SocialPostRun } from "./models/SocialPostRun.js";
import { SocialConnection } from "../identity/models/SocialConnection.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";
import { canReadAnalytics } from "../../infra/http-client/linkedin-auth.js";
import { LinkedInApiError } from "../../infra/http-client/linkedin-post.js";
import { STATS_BATCH_SIZE, fetchMemberPostStats } from "../../infra/http-client/linkedin-stats.js";

/**
 * Refreshing the engagement figures on published posts.
 *
 * Dormant on this deployment, and written to say so rather than to fail: the
 * analytics scope is not granted to this application today, so the first thing
 * every user's pass does is check what LinkedIn actually granted and skip. See
 * `linkedin-stats` for why the client exists at all under those conditions.
 *
 * The shape follows the post runner beside it — find what is due, work through
 * it per user, isolate failures — because it is the same kind of job and should
 * read the same way.
 */

/** Users touched per tick, so one run cannot outlive the function timeout. */
const MAX_USERS_PER_RUN = 25;
/** Batches per user per tick. At 50 URNs each, 4 covers 200 posts. */
const MAX_BATCHES_PER_USER = 4;

/**
 * How far back to keep refreshing.
 *
 * Engagement on a LinkedIn post is effectively settled within a few weeks, and
 * re-fetching a six-month-old post forever spends the rate limit on numbers that
 * will not change.
 */
const REFRESH_WINDOW_DAYS = 30;

/**
 * How long a row's figures stay fresh before being fetched again.
 *
 * Posts published in the last day move fast and are refreshed on every tick;
 * anything older is left alone for a day.
 */
const RECENT_POST_HOURS = 24;
const STALE_AFTER_HOURS = 12;

export type StatsSummary = {
  /** Connections examined. */
  users: number;
  /** Posts whose figures were updated. */
  updated: number;
  /** Users skipped because their token cannot read analytics. */
  skippedNoScope: number;
  errors: string[];
};

/**
 * Refresh statistics for every user with posts worth updating.
 *
 * Always resolves. A user whose token has died or whose app lacks permission is
 * recorded and stepped over — a stats refresh is a background nicety, and one
 * bad connection must not stop everyone else's figures from updating.
 */
export async function runStatsRefresh(now: Date = new Date()): Promise<StatsSummary> {
  const summary: StatsSummary = { users: 0, updated: 0, skippedNoScope: 0, errors: [] };

  const since = new Date(now.getTime() - REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const staleBefore = new Date(now.getTime() - STALE_AFTER_HOURS * 60 * 60 * 1000);
  const recentSince = new Date(now.getTime() - RECENT_POST_HOURS * 60 * 60 * 1000);

  /**
   * Rows that could gain figures: published, inside the window, carrying a URN,
   * and either never fetched, recently published, or fetched long enough ago to
   * have changed.
   *
   * Rows marked `scope` are deliberately included. That flag is the *default*
   * for a new row and means "never successfully fetched", not "permanently
   * refused" — excluding them would mean nothing is ever fetched at all once
   * permission arrives.
   */
  const due: Record<string, unknown> = {
    status: "published",
    postUrn: { $type: "string", $gt: "" },
    publishedAt: { $gte: since },
    $or: [
      { "stats.fetchedAt": null },
      { "stats.fetchedAt": { $lte: staleBefore } },
      { publishedAt: { $gte: recentSince } },
    ],
  };

  // One pass per user, because the statistics call is per-member: it takes the
  // author URN and that member's own token.
  const userIds = (await SocialPostRun.distinct("userId", due) as Types.ObjectId[])
    .slice(0, MAX_USERS_PER_RUN);

  for (const userId of userIds) {
    summary.users++;
    try {
      summary.updated += await refreshForUser(userId, due, now, summary);
    } catch (e) {
      summary.errors.push(`${String(userId)}: ${(e as Error).message}`);
    }
  }

  return summary;
}

/** Refresh one user's posts, returning how many rows were updated. */
async function refreshForUser(
  userId: Types.ObjectId,
  due: Record<string, unknown>,
  now: Date,
  summary: StatsSummary,
): Promise<number> {
  const conn = await SocialConnection.findOne({ userId, provider: "linkedin" })
    .select("+accessToken providerUserId scope expiresAt");

  // No connection, a dead token, or — the case that applies today — an app with
  // no analytics permission. All three mean "do not ask LinkedIn", and none is
  // an error worth reporting: the rows keep their `scope` marker and the Sent
  // tab keeps showing dashes.
  if (!conn || !conn.providerUserId) return 0;
  if (!canReadAnalytics(conn.scope)) {
    summary.skippedNoScope++;
    return 0;
  }
  if (conn.expiresAt.getTime() <= Date.now()) return 0;

  const token = decryptSecret(conn.accessToken);
  if (!token) return 0;

  // Oldest refresh first, so a capped tick works through the backlog rather
  // than re-fetching the same newest handful every time.
  const rows = await SocialPostRun.find({ ...due, userId })
    .sort({ "stats.fetchedAt": 1, publishedAt: -1 })
    .limit(STATS_BATCH_SIZE * MAX_BATCHES_PER_USER)
    .select("postUrn");

  let updated = 0;

  for (let i = 0; i < rows.length; i += STATS_BATCH_SIZE) {
    const batch = rows.slice(i, i + STATS_BATCH_SIZE);
    const urns = batch.map((r) => r.postUrn);

    let stats;
    try {
      stats = await fetchMemberPostStats(token, conn.providerUserId, urns);
    } catch (e) {
      if (e instanceof LinkedInApiError) {
        // Status only in the log — never a response body, which can echo a token.
        console.error(`[social] stats fetch failed (${e.kind}, status ${e.status})`);

        if (e.kind === "permission") {
          // The app is not allowed to read analytics. Nothing to retry, for this
          // user or the next batch, so the pass ends quietly.
          summary.skippedNoScope++;
          return updated;
        }
        if (e.kind === "auth") {
          await SocialConnection.updateOne({ _id: conn._id }, { $set: { expiresAt: new Date(0) } });
          return updated;
        }
        // Rate limited, sunset version, or a transient API fault: stop this
        // user's pass and let the next tick try again.
        return updated;
      }
      throw e;
    }

    for (const row of batch) {
      const found = stats.get(row.postUrn);

      // A post LinkedIn had nothing for is marked `pending` rather than left
      // untouched: without stamping `fetchedAt` it stays permanently at the
      // front of the oldest-first queue and crowds out everything behind it.
      const update = found
        ? {
            "stats.impressions": found.impressions,
            "stats.uniqueImpressions": found.uniqueImpressions,
            "stats.likes": found.likes,
            "stats.comments": found.comments,
            "stats.shares": found.shares,
            "stats.clicks": found.clicks,
            "stats.engagement": found.engagement,
            "stats.fetchedAt": now,
            "stats.unavailable": "",
          }
        : { "stats.fetchedAt": now, "stats.unavailable": "pending" };

      await SocialPostRun.updateOne({ _id: row._id }, { $set: update }).catch(() => {});
      if (found) updated++;
    }
  }

  return updated;
}
