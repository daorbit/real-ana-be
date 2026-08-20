import axios from "axios";
import { LinkedInApiError } from "./linkedin-post.js";

/**
 * Reading engagement figures for a member's own posts.
 *
 * Written against LinkedIn's Member Post Analytics API, which this application
 * is not currently permitted to call: the scope it needs,
 * `r_member_postAnalytics`, is minted by a product the developer app has not
 * been granted, and the product that would grant the neighbouring
 * `r_member_social` cannot even be requested alongside the ones already
 * provisioned. See `LINKEDIN_READ_SCOPES` for the full account.
 *
 * It exists anyway, and is wired into the refresh job, for one reason: the
 * alternative is a Sent tab whose stats columns are hard-coded to dashes, which
 * would have to be found and rewritten the day permission arrives. Everything
 * here is gated on the granted scope rather than on a flag, so the feature turns
 * itself on when LinkedIn starts granting it and stays quiet until then. The
 * caller never asks whether it is allowed — it asks for figures and is told
 * `unavailable`.
 */

const REST_BASE = "https://api.linkedin.com/rest";

/**
 * LinkedIn's cap on URNs per statistics request.
 *
 * Their documented ceiling for the `shares` list. Exceeding it is a 400 for the
 * whole batch rather than a truncated answer, so the caller chunks to this.
 */
export const STATS_BATCH_SIZE = 50;

function apiVersion(): string {
  return process.env.LINKEDIN_API_VERSION || "202608";
}

/** Engagement for a single post, in the shape the run model stores. */
export type PostStats = {
  postUrn: string;
  impressions: number | null;
  uniqueImpressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  engagement: number | null;
};

/**
 * Read a number LinkedIn may simply not have sent.
 *
 * Absent and zero are deliberately not conflated: a field LinkedIn omits means
 * it has nothing to report yet, and storing that as 0 would render as a real
 * measurement of no engagement. Null travels all the way to the UI as a dash.
 */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build the Rest.li list literal the statistics endpoint expects.
 *
 * `List(urn:li:share:1,urn:li:share:2)` — a protocol-2.0 shape rather than
 * repeated query parameters, and one that must not be percent-encoded as a
 * whole, which is why the URL is assembled by hand instead of with
 * `URLSearchParams`. The URNs themselves contain only characters that are safe
 * unencoded here.
 */
function shareList(urns: string[]): string {
  return `List(${urns.join(",")})`;
}

/**
 * Fetch engagement for up to `STATS_BATCH_SIZE` posts belonging to one member.
 *
 * Returns a map keyed by URN, holding only the posts LinkedIn had figures for —
 * a post too new to have any is simply absent, which the caller records as
 * `pending` rather than as zero engagement.
 *
 * Throws `LinkedInApiError` with kind `permission` when the token lacks the
 * analytics scope. That is the expected outcome on this deployment today, and
 * the refresh job treats it as "stop asking" rather than as a fault.
 */
export async function fetchMemberPostStats(
  accessToken: string,
  memberId: string,
  postUrns: string[],
): Promise<Map<string, PostStats>> {
  const out = new Map<string, PostStats>();
  if (!postUrns.length) return out;

  if (postUrns.length > STATS_BATCH_SIZE) {
    throw new Error(`at most ${STATS_BATCH_SIZE} URNs per request`);
  }

  const url =
    `${REST_BASE}/memberShareStatistics`
    + `?q=memberAndShare`
    + `&author=${encodeURIComponent(`urn:li:person:${memberId}`)}`
    + `&shares=${shareList(postUrns)}`;

  let res;
  try {
    res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": apiVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
      },
      timeout: 15000,
      validateStatus: () => true,
    });
  } catch {
    throw new LinkedInApiError("network", 0, "could not reach LinkedIn for post statistics");
  }

  if (res.status === 401) {
    throw new LinkedInApiError("auth", 401, "the LinkedIn token is no longer valid");
  }
  if (res.status === 403) {
    // The ordinary case on this deployment. Distinguished by kind so the caller
    // can disable the feature for this connection rather than retry it hourly.
    throw new LinkedInApiError(
      "permission",
      403,
      "this LinkedIn app is not permitted to read member post analytics",
    );
  }
  if (res.status !== 200) {
    throw new LinkedInApiError(
      res.status === 429 ? "rate-limit" : res.status === 426 ? "version" : "api",
      res.status,
      `post statistics were not returned (status ${res.status})`,
    );
  }

  for (const row of (res.data?.elements ?? []) as Record<string, unknown>[]) {
    // The element names the post it describes; without that it cannot be
    // matched to a row and is dropped rather than guessed at.
    const urn = String(row.share ?? row.ugcPost ?? "");
    if (!urn) continue;

    const totals = (row.totalShareStatistics ?? row) as Record<string, unknown>;

    out.set(urn, {
      postUrn: urn,
      impressions: count(totals.impressionCount),
      uniqueImpressions: count(totals.uniqueImpressionsCount),
      likes: count(totals.likeCount),
      comments: count(totals.commentCount),
      shares: count(totals.shareCount),
      clicks: count(totals.clickCount),
      engagement: count(totals.engagement),
    });
  }

  return out;
}
