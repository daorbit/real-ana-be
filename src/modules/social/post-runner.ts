import axios from "axios";
import { ScheduledPost } from "./models/ScheduledPost.js";
import { computeNextRun } from "./schedule-time.js";
import { SocialConnection } from "../identity/models/SocialConnection.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";
import {
  LinkedInApiError,
  createImagePost,
  createTextPost,
  uploadImage,
} from "../../infra/http-client/linkedin-post.js";

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
 * Publish one schedule.
 *
 * Throws with a message already written for the user — the caller stores it on
 * the schedule and the studio shows it verbatim, so nothing raw from LinkedIn
 * is allowed to reach here.
 */
async function publish(post: InstanceType<typeof ScheduledPost>): Promise<string | null> {
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
      return created.postUrl;
    }

    const { bytes, mime } = await fetchImage(post.imageUrl);
    const uploaded = await uploadImage(token, conn.providerUserId, bytes, mime);
    const created = await createImagePost(token, conn.providerUserId, post.caption, uploaded.urn);
    return created.postUrl;
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
      const url = await publish(post);
      post.set({
        lastStatus: "ok",
        lastError: "",
        lastPostUrl: url ?? "",
        postCount: (post.postCount ?? 0) + 1,
      });
      summary.posted++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unable to publish the LinkedIn post.";
      post.set({ lastStatus: "failed", lastError: message });
      summary.failed++;
      summary.errors.push(`${post.id}: ${message}`);
    }

    // Always advances, success or failure — see the note at the top.
    post.set({
      lastRunAt: now,
      nextRunAt: computeNextRun(
        {
          frequency: post.frequency,
          hour: post.hour,
          minute: post.minute,
          timezone: post.timezone,
          weekday: post.weekday,
          dayOfMonth: post.dayOfMonth,
        },
        now,
      ),
    });

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
