import axios from "axios";
import { ScheduledPost } from "./models/ScheduledPost.js";
import { SocialPostRun } from "./models/SocialPostRun.js";
import { computeNextRun } from "./schedule-time.js";
import { SocialConnection } from "../identity/models/SocialConnection.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";
import {
  LinkedInApiError,
  createImagePost,
  createMultiImagePost,
  createTextPost,
  uploadImage,
} from "../../infra/http-client/linkedin-post.js";
import {
  InstagramApiError,
  createImagePost as createInstagramPost,
} from "../../infra/http-client/instagram-post.js";
import { canPublish as canPublishInstagram } from "../../infra/http-client/instagram-auth.js";

/**
 * Every image on a post, in publish order.
 *
 * The first still lives in `imageUrl` and the rest in `extraImages` — see the
 * model for why they were not merged — so this is the one place that shape is
 * flattened, and every publish path reads it rather than the two fields.
 */
function imagesOf(post: { imageUrl?: string; extraImages?: { url: string }[] }): string[] {
  return [post.imageUrl ?? "", ...(post.extraImages ?? []).map((i) => i.url)].filter(Boolean);
}

/**
 * Publishing due schedules.
 *
 * Called from the cron route on a fixed tick. Everything it publishes was
 * written by hand in the studio and stored whole, so this does no content
 * generation of its own — it fetches the image, hands both to LinkedIn, and
 * records what happened.
 *
 * The shape follows the report runner: find what is due, run each independently,
 * and always advance `nextRunAt` afterwards. That last part is the important
 * one. A schedule whose run failed still moves to its next slot rather than
 * staying due, because a permanently-failing schedule that stays due is
 * retried on every tick forever.
 */

/** Cap per tick, so one run cannot outlive the platform's function timeout. */
const MAX_PER_RUN = 20;
/** Refuse anything larger; LinkedIn's own ceiling is well above this. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The last-resort message, for a thrown value that was not an `Error` at all.
 *
 * Named after the network the schedule targets, because it is shown to the user
 * verbatim and "unable to publish the LinkedIn post" on an Instagram schedule is
 * worse than saying nothing specific.
 */
function fallbackMessage(post: InstanceType<typeof ScheduledPost>): string {
  return post.provider === "instagram"
    ? "Unable to publish the Instagram post."
    : "Unable to publish the LinkedIn post.";
}

export type RunSummary = {
  attempted: number;
  posted: number;
  failed: number;
  errors: string[];
};

/**
 * Fetch the stored image so its bytes can be uploaded to LinkedIn.
 *
 * LinkedIn will not take a URL — it issues an upload target and wants the bytes
 * — so the image has to come back to us first. This is the one outbound fetch
 * here, and it goes to Cloudinary, which is where the studio put the file.
 */
async function fetchImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: MAX_IMAGE_BYTES,
    validateStatus: () => true,
  });

  if (res.status !== 200) throw new Error(`image fetch failed (status ${res.status})`);

  const mime = String(res.headers["content-type"] ?? "").split(";")[0].trim();
  if (!mime.startsWith("image/")) throw new Error("stored file is not an image");

  return { bytes: Buffer.from(res.data), mime };
}

/**
 * Publish one schedule, on whichever network it targets.
 *
 * Throws with a message already written for the user — the caller stores it on
 * the schedule and the studio shows it verbatim, so nothing raw from either API
 * is allowed to reach here.
 */
async function publish(
  post: InstanceType<typeof ScheduledPost>,
): Promise<{ postUrl: string | null; postUrn: string }> {
  return post.provider === "instagram" ? publishInstagram(post) : publishLinkedIn(post);
}

/**
 * Publish to Instagram.
 *
 * Shorter than the LinkedIn path below because Instagram fetches the image
 * itself: the Cloudinary URL already on the schedule is handed straight over,
 * with no download into this process and no byte upload. See `instagram-post`.
 */
async function publishInstagram(
  post: InstanceType<typeof ScheduledPost>,
): Promise<{ postUrl: string | null; postUrn: string }> {
  const conn = await SocialConnection.findOne({
    userId: post.userId,
    provider: "instagram",
  }).select("+accessToken");

  if (!conn) throw new Error("Instagram is not connected. Reconnect it to resume this schedule.");
  if (!conn.providerUserId) {
    throw new Error("Instagram connection is incomplete. Please reconnect Instagram.");
  }
  if (!canPublishInstagram(conn.scope)) {
    throw new Error("Reconnect Instagram and allow posting to resume this schedule.");
  }
  if (conn.expiresAt.getTime() <= Date.now()) {
    throw new Error("Your Instagram connection has expired. Please reconnect Instagram.");
  }

  // Instagram has no text-only post: a container is created *around* a media
  // URL. Caught here so the schedule reports something actionable rather than a
  // parameter error from the API.
  if (!post.imageUrl) {
    throw new Error("Instagram posts need an image. Add one to this schedule to resume it.");
  }

  const token = decryptSecret(conn.accessToken);
  if (!token) {
    throw new Error("Your Instagram connection is no longer valid. Please reconnect Instagram.");
  }

  try {
    const created = await createInstagramPost(
      token,
      conn.providerUserId,
      // One URL publishes as a single image, several as a carousel — the client
      // picks the container shape from the length.
      imagesOf(post),
      post.caption,
    );
    return { postUrl: created.permalink, postUrn: created.mediaId };
  } catch (e) {
    if (e instanceof InstagramApiError) {
      // Status and kind only in the log — never a response body, which echoes
      // the request, and these requests carry the token as a query parameter.
      console.error(`[social] instagram publish failed (${e.kind}, status ${e.status})`);

      if (e.kind === "auth") {
        // The token is dead. Mark it expired so the studio prompts a reconnect
        // and every other schedule on this account stops trying too.
        await SocialConnection.updateOne({ _id: conn._id }, { $set: { expiresAt: new Date(0) } });
        throw new Error("Your Instagram connection has expired. Please reconnect Instagram.");
      }
      if (e.kind === "permission") {
        throw new Error(
          "Instagram refused the post. Reconnect Instagram to grant posting permission.",
        );
      }
      if (e.kind === "rate-limit") {
        throw new Error("Instagram is rate limiting posts. This run was skipped.");
      }
      if (e.kind === "container") {
        // The image itself was rejected — unreachable, too large, or outside the
        // 4:5 to 1.91:1 aspect range. The message is Meta's own text about the
        // media, which is the one thing here the user can actually act on.
        throw new Error(e.message);
      }
      if (e.kind === "version") {
        console.error("[social] Instagram API version is sunset — set INSTAGRAM_API_VERSION");
        throw new Error(
          "Instagram publishing is temporarily unavailable while we update to their latest API.",
        );
      }
      throw new Error("Unable to publish the Instagram post.");
    }
    throw e;
  }
}

/**
 * Publish to LinkedIn.
 *
 * Unlike Instagram, LinkedIn will not take a URL — it issues an upload target
 * and wants the bytes — so the image is fetched back into this process first.
 */
async function publishLinkedIn(
  post: InstanceType<typeof ScheduledPost>,
): Promise<{ postUrl: string | null; postUrn: string }> {
  const conn = await SocialConnection.findOne({
    userId: post.userId,
    provider: "linkedin",
  }).select("+accessToken");

  if (!conn) throw new Error("LinkedIn is not connected. Reconnect it to resume this schedule.");
  if (!conn.providerUserId) throw new Error("LinkedIn connection is incomplete. Please reconnect LinkedIn.");
  // A sign-in-only connection carries no publishing grant; see `canPublish` in
  // the LinkedIn routes for why the two are now separate consents.
  if (!(conn.scope ?? "").split(/[\s,]+/).includes("w_member_social")) {
    throw new Error("Reconnect LinkedIn and allow posting to resume this schedule.");
  }
  if (conn.expiresAt.getTime() <= Date.now()) {
    throw new Error("Your LinkedIn connection has expired. Please reconnect LinkedIn.");
  }

  const token = decryptSecret(conn.accessToken);
  if (!token) throw new Error("Your LinkedIn connection is no longer valid. Please reconnect LinkedIn.");

  try {
    // No image is a valid post: the caption alone goes out, and LinkedIn builds
    // its own preview from any link inside it.
    if (!post.imageUrl) {
      const created = await createTextPost(token, conn.providerUserId, post.caption);
      return { postUrl: created.postUrl, postUrn: created.postUrn };
    }

    // Every image is uploaded before any post is created: LinkedIn wants URNs,
    // and a half-uploaded set is discardable in a way a half-published post is
    // not. Sequential rather than parallel, so a rate limit stops the run
    // instead of stranding several uploads.
    const urns: string[] = [];
    for (const url of imagesOf(post)) {
      const { bytes, mime } = await fetchImage(url);
      const uploaded = await uploadImage(token, conn.providerUserId, bytes, mime);
      urns.push(uploaded.urn);
    }

    const created = urns.length > 1
      ? await createMultiImagePost(token, conn.providerUserId, post.caption, urns)
      : await createImagePost(token, conn.providerUserId, post.caption, urns[0]);
    return { postUrl: created.postUrl, postUrn: created.postUrn };
  } catch (e) {
    if (e instanceof LinkedInApiError) {
      // Status only in the log — never a response body, which can echo a token.
      console.error(`[social] publish failed (${e.kind}, status ${e.status})`);

      if (e.kind === "auth") {
        // The token is dead. Mark it expired so the studio prompts a reconnect
        // and every other schedule on this account stops trying too.
        await SocialConnection.updateOne({ _id: conn._id }, { $set: { expiresAt: new Date(0) } });
        throw new Error("Your LinkedIn connection has expired. Please reconnect LinkedIn.");
      }
      if (e.kind === "permission") {
        throw new Error("LinkedIn refused the post. Reconnect LinkedIn to grant posting permission.");
      }
      if (e.kind === "rate-limit") {
        throw new Error("LinkedIn is rate limiting posts. This run was skipped.");
      }
      if (e.kind === "version") {
        // The deployment is pinned to a retired LinkedIn API version. An
        // operator has to bump `LINKEDIN_API_VERSION`; the schedule keeps its
        // slot and will publish once that is done.
        console.error("[social] LinkedIn API version is sunset — set LINKEDIN_API_VERSION");
        throw new Error(
          "LinkedIn publishing is temporarily unavailable while we update to their latest API.",
        );
      }
      throw new Error("Unable to publish the LinkedIn post.");
    }
    throw e;
  }
}

/**
 * Record what a publish attempt did, as a permanent row.
 *
 * Separate from the bookkeeping written back onto the schedule, which keeps only
 * the most recent outcome. This is the history the Sent tab reads — see
 * `SocialPostRun` for why the caption and image are copied rather than
 * referenced.
 *
 * Never throws. A publish that reached LinkedIn has already happened, and
 * failing the caller because the local record of it could not be written would
 * turn a successful post into a reported failure — and, on the cron path, into a
 * retry that publishes the same thing twice.
 */
async function recordRun(
  post: InstanceType<typeof ScheduledPost>,
  source: "schedule" | "manual",
  outcome:
    | { status: "published"; postUrl: string | null; postUrn: string }
    | { status: "failed"; error: string },
  now: Date,
): Promise<void> {
  try {
    await SocialPostRun.create({
      userId: post.userId,
      provider: post.provider,
      workspaceId: post.workspaceId,
      scheduledPostId: post._id,
      source,
      status: outcome.status,
      postUrn: outcome.status === "published" ? outcome.postUrn : "",
      postUrl: outcome.status === "published" ? (outcome.postUrl ?? "") : "",
      caption: post.caption,
      imageUrl: post.imageUrl,
      name: post.name,
      publishedAt: now,
      error: outcome.status === "failed" ? outcome.error : "",
    });
  } catch (e) {
    console.error(`[social] could not record run for ${post.id}:`, (e as Error).message);
  }
}

/**
 * Publish one schedule immediately, on request rather than on a tick.
 *
 * The cadence is deliberately left alone: "post this now" is an extra send, not
 * a rescheduling, so a weekly post published by hand on Monday still goes out on
 * its Wednesday slot. Only the outcome fields are written, which is what the
 * studio reads to show the result.
 *
 * Throws the same user-ready messages `publish` does, for the route to surface.
 */
export async function publishNow(
  post: InstanceType<typeof ScheduledPost>,
  now: Date = new Date(),
): Promise<string | null> {
  let result: { postUrl: string | null; postUrn: string };
  try {
    result = await publish(post);
  } catch (e) {
    // Recorded before it is rethrown, so a manual send that fails leaves the
    // same trail on the schedule as a failed tick — the studio's error line is
    // read from these fields, not from the response.
    const message = e instanceof Error ? e.message : fallbackMessage(post);
    post.set({ lastStatus: "failed", lastError: message, lastRunAt: now });
    await post.save().catch(() => {});
    await recordRun(post, "manual", { status: "failed", error: message }, now);
    throw e;
  }

  // Written before the schedule's own fields: this is the row the Sent tab
  // reads, and it is the only place the URN survives.
  await recordRun(post, "manual", { status: "published", ...result }, now);

  post.set({
    lastStatus: "ok",
    lastError: "",
    lastPostUrl: result.postUrl ?? "",
    lastRunAt: now,
    postCount: (post.postCount ?? 0) + 1,
  });
  await post.save();

  return result.postUrl;
}

/**
 * Publish everything currently due.
 *
 * Each schedule is isolated: one failure records itself and the loop continues,
 * because a single bad row must not stop every other user's post from going out.
 */
export async function runDuePosts(now: Date = new Date()): Promise<RunSummary> {
  const due = await ScheduledPost.find({ status: "active", nextRunAt: { $lte: now } })
    .sort({ nextRunAt: 1 })
    .limit(MAX_PER_RUN);

  const summary: RunSummary = { attempted: due.length, posted: 0, failed: 0, errors: [] };

  for (const post of due) {
    try {
      const result = await publish(post);
      await recordRun(post, "schedule", { status: "published", ...result }, now);
      post.set({
        lastStatus: "ok",
        lastError: "",
        lastPostUrl: result.postUrl ?? "",
        postCount: (post.postCount ?? 0) + 1,
      });
      summary.posted++;
    } catch (e) {
      const message = e instanceof Error ? e.message : fallbackMessage(post);
      await recordRun(post, "schedule", { status: "failed", error: message }, now);
      post.set({ lastStatus: "failed", lastError: message });
      summary.failed++;
      summary.errors.push(`${post.id}: ${message}`);
    }

    // Always leaves the due window, success or failure — see the note at the
    // top. A one-off has no next slot, so it retires into `sent`; a repeat
    // advances to its next cadence.
    post.set(
      post.mode === "once"
        ? { lastRunAt: now, status: "sent" }
        : {
            lastRunAt: now,
            nextRunAt: computeNextRun(
              {
                frequency: post.frequency as never,
                hour: post.hour,
                minute: post.minute,
                timezone: post.timezone,
                weekday: post.weekday,
                dayOfMonth: post.dayOfMonth,
              },
              now,
            ),
          },
    );

    try {
      await post.save();
    } catch (e) {
      // Losing the bookkeeping write is worth a line in the log: the schedule
      // stays due and will be attempted again on the next tick.
      console.error(`[social] could not save schedule ${post.id}:`, (e as Error).message);
    }
  }

  return summary;
}
