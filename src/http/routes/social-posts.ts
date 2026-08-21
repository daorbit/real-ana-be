import { Router, Response } from "express";
import {
  ScheduledPost, POST_FREQUENCIES, POST_MODES, POST_STATUSES, POST_PROVIDERS, PostProvider,
  POST_FORMATS, PostFormat,
} from "../../modules/social/models/ScheduledPost.js";
import { computeNextRun } from "../../modules/social/schedule-time.js";
import { publishNow } from "../../modules/social/post-runner.js";
import { SocialPostRun } from "../../modules/social/models/SocialPostRun.js";
import { SocialConnection } from "../../modules/identity/models/SocialConnection.js";
import { canReadAnalytics } from "../../infra/http-client/linkedin-auth.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import {
  checkImageDataUrl, cloudinaryConfigured, deleteImage, uploadImage,
} from "../../infra/storage/cloudinary.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { dashboardCors } from "../middleware/cors.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/index.js";
import {
  canCreateScheduledPost, canUseRepeatingPosts,
} from "../../modules/billing/quota.service.js";

/**
 * Scheduled LinkedIn posts: the studio's own CRUD surface.
 *
 * Mounted at `/api/social/posts`. Everything here is scoped to the signed-in
 * user — a schedule publishes as them, using their LinkedIn token, so it is
 * theirs to read and change and nobody else's, including other members of the
 * same workspace.
 *
 * The image is handled the way avatars already are: the studio sends a base64
 * data URL, it is validated and uploaded to Cloudinary here, and only the
 * resulting URL is stored. The cron runner fetches that URL at publish time,
 * because LinkedIn wants bytes rather than a link.
 */

const router = Router();

// Preflight. Every write here — POST, PATCH, DELETE — carries an
// `Authorization` header, which makes the request non-simple and sends an
// OPTIONS first. That arrives before any per-route middleware, so without this
// the browser reports a CORS failure and the real request is never made.
router.options("*", dashboardCors);

/** LinkedIn's commentary cap, and the schema's ceiling. */
const MAX_CAPTION = 3000;
/** Instagram's own, which is lower. Enforced per provider — see `readCaption`. */
const MAX_CAPTION_INSTAGRAM = 2200;
/** Generous for a feed image, and well under LinkedIn's own ceiling. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The fields safe to return. The Cloudinary public id is ours, not the client's. */
function publicPost(doc: InstanceType<typeof ScheduledPost>) {
  return {
    id: doc.id,
    provider: doc.provider,
    format: doc.format,
    workspaceId: String(doc.workspaceId),
    name: doc.name,
    caption: doc.caption,
    imageUrl: doc.imageUrl,
    // Flattened for the client: it edits one ordered list, and which field an
    // image lives in is the model's business. See `storeImages`.
    images: [doc.imageUrl, ...doc.extraImages.map((i) => i.url)].filter(Boolean),
    mode: doc.mode,
    runAt: doc.runAt,
    frequency: doc.frequency,
    hour: doc.hour,
    minute: doc.minute,
    timezone: doc.timezone,
    weekday: doc.weekday,
    dayOfMonth: doc.dayOfMonth,
    status: doc.status,
    nextRunAt: doc.nextRunAt,
    lastRunAt: doc.lastRunAt,
    lastStatus: doc.lastStatus,
    lastError: doc.lastError,
    lastPostUrl: doc.lastPostUrl,
    postCount: doc.postCount,
    createdAt: doc.get("createdAt"),
  };
}

/**
 * One row of published history, as the Sent tab renders it.
 *
 * Counts are passed through as nulls rather than coerced to 0 — see the stats
 * subdocument on `SocialPostRun`. A dash and a zero say different things, and
 * the difference has to survive serialisation to be shown.
 */
function publicRun(doc: InstanceType<typeof SocialPostRun>) {
  const stats = doc.stats ?? {};
  return {
    id: doc.id,
    provider: doc.provider,
    format: doc.format,
    scheduledPostId: doc.scheduledPostId ? String(doc.scheduledPostId) : null,
    workspaceId: doc.workspaceId ? String(doc.workspaceId) : null,
    name: doc.name,
    caption: doc.caption,
    imageUrl: doc.imageUrl,
    source: doc.source,
    status: doc.status,
    error: doc.error,
    postUrl: doc.postUrl,
    publishedAt: doc.publishedAt,
    stats: {
      impressions: stats.impressions ?? null,
      uniqueImpressions: stats.uniqueImpressions ?? null,
      likes: stats.likes ?? null,
      comments: stats.comments ?? null,
      shares: stats.shares ?? null,
      clicks: stats.clicks ?? null,
      engagement: stats.engagement ?? null,
      fetchedAt: stats.fetchedAt ?? null,
      unavailable: stats.unavailable ?? "scope",
    },
  };
}

/**
 * Validate and normalise the schedule fields of a request body.
 *
 * Returns the cadence in the shape the model and the time helper both expect.
 * Every bound is enforced here rather than left to Mongoose so the caller gets
 * a 400 naming the field instead of a 500 from a failed validator.
 */
function readSchedule(body: Record<string, unknown>) {
  const mode = String(body.mode ?? "once");
  if (!POST_MODES.includes(mode as never)) {
    throw badRequest(`mode must be one of ${POST_MODES.join(", ")}`);
  }

  const timezone = String(body.timezone ?? "UTC").trim() || "UTC";

  // A single post is pinned to one instant, which the studio sends as an ISO
  // string it built from the date and time the author picked in their own zone.
  if (mode === "once") {
    const runAt = new Date(String(body.runAt ?? ""));
    if (Number.isNaN(runAt.getTime())) {
      throw badRequest("runAt must be a valid date and time");
    }
    // A minute of slack: the studio's clock and ours are never exactly aligned,
    // and refusing a time the user sees as "now" would be wrong.
    if (runAt.getTime() < Date.now() - 60 * 1000) {
      throw badRequest("Pick a time in the future.");
    }
    return { mode: "once" as const, runAt, timezone };
  }

  const frequency = String(body.frequency ?? "");
  if (!POST_FREQUENCIES.includes(frequency as never)) {
    throw badRequest(`frequency must be one of ${POST_FREQUENCIES.join(", ")}`);
  }

  const hour = Number(body.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw badRequest("hour must be a whole number between 0 and 23");
  }

  const minute = Number(body.minute ?? 0);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw badRequest("minute must be a whole number between 0 and 59");
  }

  const weekday = Number(body.weekday ?? 1);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw badRequest("weekday must be a whole number between 0 and 6");
  }

  // Capped at 28 so every month contains the day — a schedule set for the 31st
  // would otherwise skip most of the year.
  const dayOfMonth = Number(body.dayOfMonth ?? 1);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    throw badRequest("dayOfMonth must be a whole number between 1 and 28");
  }

  return {
    mode: "repeat" as const,
    frequency: frequency as (typeof POST_FREQUENCIES)[number],
    hour,
    minute,
    weekday,
    dayOfMonth,
    timezone,
  };
}

/** When a validated schedule first fires, whichever mode it is in. */
function firstRun(schedule: ReturnType<typeof readSchedule>): Date {
  return schedule.mode === "once" ? schedule.runAt : computeNextRun(schedule);
}

/**
 * The caption, checked for presence and length.
 *
 * The cap depends on the network: Instagram truncates at 2200 characters and
 * LinkedIn at 3000. Checked here rather than in the schema, which has to hold
 * the larger of the two — a blanket 2200 would silently shorten what LinkedIn
 * accepts, and rejecting at save time is far kinder than discovering it when the
 * post goes out clipped mid-sentence.
 */
function readCaption(value: unknown, provider: PostProvider): string {
  const caption = String(value ?? "").trim();
  if (!caption) throw badRequest("Caption cannot be empty.");

  const limit = provider === "instagram" ? MAX_CAPTION_INSTAGRAM : MAX_CAPTION;
  if (caption.length > limit) {
    throw badRequest(`Caption must be ${limit} characters or fewer for ${providerName(provider)}.`);
  }
  return caption;
}

/**
 * Refuse a schedule for a network this user cannot actually publish to.
 *
 * Both halves matter: no connection at all, and a connection whose granted
 * scopes stop short of publishing — which is a real state on both networks,
 * since signing in with LinkedIn does not grant `w_member_social` and an
 * Instagram user can decline publishing on the consent screen.
 *
 * The expiry is deliberately *not* checked here. A token that lapses between
 * saving a schedule and running it is the ordinary case for a monthly cadence,
 * the runner reports it with a reconnect prompt, and refusing the save over it
 * would block editing a schedule for the very account that needs reconnecting.
 */
async function assertCanPublishTo(userId: string, provider: PostProvider): Promise<void> {
  const conn = await SocialConnection.findOne({ userId, provider }).select("scope");
  if (!conn) {
    throw badRequest(`Connect your ${providerName(provider)} account before scheduling a post.`);
  }

  const granted = (conn.scope ?? "").split(/[\s,]+/);
  const needed = provider === "instagram"
    ? "instagram_business_content_publish"
    : "w_member_social";

  if (!granted.includes(needed)) {
    throw forbidden(
      `Reconnect ${providerName(provider)} and allow posting to schedule a post.`,
      { reconnect: true },
    );
  }
}

/** The network's name as a person writes it, for a message they will read. */
function providerName(provider: PostProvider): string {
  return provider === "instagram" ? "Instagram" : "LinkedIn";
}

/**
 * Which network a post targets, defaulting to LinkedIn.
 *
 * Defaulted rather than required so a client that predates Instagram — or the
 * Share Panel, which only ever posts to LinkedIn — keeps working unchanged.
 */
function readProvider(value: unknown): PostProvider {
  const provider = String(value ?? "linkedin");
  if (!POST_PROVIDERS.includes(provider as PostProvider)) {
    throw badRequest("Choose a network to publish to.");
  }
  return provider as PostProvider;
}

/**
 * Upload a data-URL image and return its stored location.
 *
 * Returns nulls when no image was supplied, which is valid — a caption-only
 * post is allowed.
 */
async function storeImage(
  image: string,
  userId: string,
  /**
   * What the schedule currently points at, when there is one.
   *
   * An edit that does not touch the image resends the hosted URL rather than
   * the bytes, and the public id cannot be recovered from that URL. Without
   * this the id came back empty, the caller read empty as "a different file",
   * and deleted the asset the post still pointed at — leaving a live URL over
   * a destroyed image that only failed at publish time, with a 404.
   */
  current?: { imageUrl: string; imagePublicId: string },
  /** Story images are fitted to 9:16 on the way in — see `STORY_TRANSFORM`. */
  format: PostFormat = "feed",
): Promise<{ imageUrl: string; imagePublicId: string }> {
  if (!image) return { imageUrl: "", imagePublicId: "" };

  // Already-hosted images pass through untouched: an unchanged edit resends the
  // Cloudinary URL it was given rather than the original bytes.
  if (/^https?:\/\//i.test(image)) {
    return {
      imageUrl: image,
      // Carried over only when this is the same URL the schedule already had.
      // A different host is someone else's file, which we must not claim an id
      // for — deleting it later is not ours to do.
      imagePublicId: current && current.imageUrl === image ? current.imagePublicId : "",
    };
  }

  if (!cloudinaryConfigured()) {
    throw badRequest("Image uploads are not configured on this deployment.");
  }

  const parsed = checkImageDataUrl(image, MAX_IMAGE_BYTES);
  if ("error" in parsed) throw badRequest(parsed.error);

  const uploaded = await uploadImage({
    file: image,
    folder: "quantalog/social",
    // Unique per upload so a replacement never collides with the file it
    // supersedes while the old one is still being deleted.
    publicId: `${userId}-${Date.now()}`,
    transformation: format === "story" ? STORY_TRANSFORM : undefined,
  });

  return { imageUrl: uploaded.url, imagePublicId: uploaded.publicId };
}

/**
 * Fit an image to Instagram's story canvas before it is published.
 *
 * Instagram crops a story to fill 9:16 — it does not letterbox — so an image
 * that is not already that shape loses its edges, which is how a caption
 * rendered into the picture ends up running off both sides. The fix has to
 * happen to the file, not to the preview: by the time Graph fetches the URL
 * the shape is whatever we stored.
 *
 * `pad` rather than `fill`: fitting the whole image onto the canvas and filling
 * the remainder keeps everything the author put in the picture, where cropping
 * to fill would silently discard it. `b_auto` samples the image's own edges for
 * the padding colour, so a photograph gets a matching surround rather than
 * black bars.
 */
const STORY_TRANSFORM = "c_pad,w_1080,h_1920,b_auto";

/** Both networks cap a post at ten images. */
const MAX_POST_IMAGES = 10;

/**
 * Feed post or story, checked against the network it is going to.
 *
 * Stories are Instagram's alone, and they carry no caption — so a story on
 * LinkedIn, or a story with a caption the author expects to be published, is
 * refused here rather than silently dropped by the API.
 */
function readFormat(body: unknown, provider: PostProvider): PostFormat {
  const raw = String((body as { format?: unknown })?.format ?? "feed");
  if (!POST_FORMATS.includes(raw as PostFormat)) {
    throw badRequest("Choose a post format.");
  }
  const format = raw as PostFormat;

  if (format === "story" && provider !== "instagram") {
    throw badRequest("Stories are an Instagram format.");
  }
  return format;
}

/**
 * The post's images, in order, from either request shape.
 *
 * `images` is the multi-image form; `image` is what every client sent before
 * carousels existed and what a single-image post still sends. Accepting both
 * keeps older callers working without a version bump.
 */
function readImages(body: unknown): string[] {
  const b = (body ?? {}) as { images?: unknown; image?: unknown };
  const list = Array.isArray(b.images)
    ? b.images.filter((v): v is string => typeof v === "string" && !!v.trim())
    : [String(b.image ?? "")].filter(Boolean);

  if (list.length > MAX_POST_IMAGES) {
    throw badRequest(`A post can carry at most ${MAX_POST_IMAGES} images.`);
  }
  return list;
}

/**
 * Store every image on a post, keeping the first in `imageUrl`.
 *
 * The split is the model's — see `ScheduledPost.extraImages` — and it lives
 * here so the routes deal in one ordered list and nothing else has to know
 * which field an image landed in.
 *
 * Uploaded in sequence: a carousel is up to ten files, and ten parallel
 * Cloudinary uploads from one request is how a save times out.
 */
async function storeImages(
  images: string[],
  userId: string,
  current?: { imageUrl: string; imagePublicId: string },
  format: PostFormat = "feed",
): Promise<{
  imageUrl: string;
  imagePublicId: string;
  extraImages: { url: string; publicId: string }[];
}> {
  if (images.length === 0) return { imageUrl: "", imagePublicId: "", extraImages: [] };

  const stored: { url: string; publicId: string }[] = [];
  for (const [i, image] of images.entries()) {
    // Only the first can match what the schedule already had, so only it can
    // carry a public id forward.
    const { imageUrl, imagePublicId } = await storeImage(
      image,
      userId,
      i === 0 ? current : undefined,
      format,
    );
    if (imageUrl) stored.push({ url: imageUrl, publicId: imagePublicId });
  }

  const [first, ...rest] = stored;
  return {
    imageUrl: first?.url ?? "",
    imagePublicId: first?.publicId ?? "",
    extraImages: rest,
  };
}

/** Confirm the caller can act on this workspace before attaching a schedule to it. */
async function assertWorkspaceAccess(userId: string, workspaceId: string) {
  if (!workspaceId) throw badRequest("workspaceId is required");
  const member = await Membership.findOne({ userId, workspaceId });
  if (!member) throw forbidden("no access to that workspace");
}

/**
 * Every schedule this user owns.
 *
 * Also reports whether LinkedIn is connected, because a list of schedules is
 * misleading on its own: without a connection none of them can publish, and the
 * studio needs to say so at the top of the page rather than per row.
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const [posts, conn, igConn] = await Promise.all([
      ScheduledPost.find({ userId: req.userId }).sort({ createdAt: -1 }),
      SocialConnection.findOne({ userId: req.userId, provider: "linkedin" })
        .select("name picture expiresAt scope"),
      SocialConnection.findOne({ userId: req.userId, provider: "instagram" })
        .select("name picture expiresAt scope"),
    ]);

    res.json({
      posts: posts.map(publicPost),
      linkedin: conn
        ? {
            connected: true,
            expired: conn.expiresAt.getTime() <= Date.now(),
            name: conn.name,
            picture: conn.picture,
            // Signing in with LinkedIn grants identity only, so a connection
            // can exist that cannot post. The page needs to tell the two apart.
            canPublish: (conn.scope ?? "").split(/[\s,]+/).includes("w_member_social"),
          }
        : { connected: false, expired: false, name: "", picture: "", canPublish: false },
      // Same shape, so the composer's network picker can read one or the other
      // without special-casing. `name` is the `@username` on an Instagram row.
      instagram: igConn
        ? {
            connected: true,
            expired: igConn.expiresAt.getTime() <= Date.now(),
            name: igConn.name,
            picture: igConn.picture,
            canPublish: (igConn.scope ?? "")
              .split(/[\s,]+/)
              .includes("instagram_business_content_publish"),
          }
        : { connected: false, expired: false, name: "", picture: "", canPublish: false },
    });
  }),
);

/**
 * Published post history — what the studio's Sent tab reads.
 *
 * Newest first, paginated with a cursor rather than a page number: rows are
 * appended continuously, and an offset would skip or repeat a post whenever one
 * was published between two requests.
 *
 * The response says explicitly whether engagement figures are obtainable at all,
 * because the answer today is no and the UI must render a dash rather than a
 * zero. See `SocialPostRun`'s stats subdocument for why that distinction is
 * kept all the way down to the database.
 */
router.get(
  "/sent",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    // Bounded so a crafted `limit` cannot ask for the whole collection.
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const query: Record<string, unknown> = { userId: req.userId };

    // The cursor is the previous page's last `publishedAt`. Rows share
    // timestamps rarely enough that a strict `$lt` is the right trade against
    // carrying a compound cursor.
    const cursor = String(req.query.cursor ?? "");
    if (cursor) {
      const before = new Date(cursor);
      if (Number.isNaN(before.getTime())) throw badRequest("cursor must be a valid date");
      query.publishedAt = { $lt: before };
    }

    // Optional filter, so the studio can show one schedule's history.
    const scheduledPostId = String(req.query.scheduledPostId ?? "");
    if (scheduledPostId) query.scheduledPostId = scheduledPostId;

    /*
     * Which outcome to read.
     *
     * Runs record every attempt, successful or not, so the collection alone is
     * not an answer to either question the studio asks of it. `failed` is the
     * Failed shelf; anything else is Sent, which means published and nothing
     * else — a post that never reached LinkedIn does not belong under a
     * heading that says it did, least of all listed twice on two shelves.
     */
    query.status = String(req.query.status ?? "") === "failed" ? "failed" : "published";

    // One extra row, purely to learn whether another page exists without a
    // second count query over the same index.
    const [rows, conn] = await Promise.all([
      SocialPostRun.find(query).sort({ publishedAt: -1 }).limit(limit + 1),
      SocialConnection.findOne({ userId: req.userId, provider: "linkedin" })
        .select("name picture scope"),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      posts: page.map(publicRun),
      nextCursor: hasMore ? page[page.length - 1].publishedAt.toISOString() : null,
      /**
       * The author, so every row can show an avatar and a name without the
       * client joining anything. Denormalised into the response rather than
       * onto each row: it is the same person for all of them.
       */
      author: conn ? { name: conn.name, picture: conn.picture } : null,
      /**
       * Whether the stats columns can ever hold a number.
       *
       * False on this deployment: the LinkedIn app has no product granting
       * `r_member_postAnalytics`. The UI keys off this to render dashes and to
       * explain why, rather than showing five zeroes that read as a post nobody
       * saw. See `canReadAnalytics`.
       */
      statsAvailable: canReadAnalytics(conn?.scope),
    });
  }),
);

/** Create a schedule. */
router.post(
  "/",
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workspaceId = String(req.body?.workspaceId ?? "");
    await assertWorkspaceAccess(req.userId!, workspaceId);

    const provider = readProvider(req.body?.provider);
    const format = readFormat(req.body, provider);
    // A story publishes no caption, so one is neither required nor kept — the
    // schema wants a string, and an empty one is the honest record of what
    // went out.
    const caption = format === "story" ? "" : readCaption(req.body?.caption, provider);
    const schedule = readSchedule(req.body ?? {});

    // Refused at save time rather than at the first run: a schedule that can
    // never publish is not worth storing, and an error weeks later reads as the
    // scheduler being broken.
    await assertCanPublishTo(req.userId!, provider);

    // Checked after the schedule parses, so a malformed request is refused for
    // being malformed rather than reported as a plan limit.
    const allowed = await canCreateScheduledPost(workspaceId);
    if (!allowed.ok) throw forbidden(allowed.error);

    if (schedule.mode === "repeat") {
      const repeats = await canUseRepeatingPosts(workspaceId);
      if (!repeats.ok) throw forbidden(repeats.error);
    }

    const name = String(req.body?.name ?? "").trim() || "Scheduled post";
    const { imageUrl, imagePublicId, extraImages } = await storeImages(
      readImages(req.body),
      req.userId!,
      undefined,
      format,
    );

    // Instagram has no text-only post — a container is created around a media
    // URL — so an image is required there and optional on LinkedIn.
    if (provider === "instagram" && !imageUrl) {
      throw badRequest("Instagram posts need an image.");
    }
    // One story, one image. Instagram publishes stories individually, and
    // silently taking the first of several would lose the rest without saying
    // so.
    if (format === "story" && extraImages.length > 0) {
      throw badRequest("A story carries one image. Post the rest separately.");
    }

    const doc = await ScheduledPost.create({
      userId: req.userId,
      provider,
      format,
      workspaceId,
      name,
      caption,
      imageUrl,
      imagePublicId,
      extraImages,
      ...schedule,
      status: "active",
      nextRunAt: firstRun(schedule),
    });

    res.status(201).json(publicPost(doc));
  }),
);

/**
 * Update a schedule.
 *
 * `nextRunAt` is recomputed whenever the cadence changes, so an edit takes
 * effect immediately rather than after one more run at the old time.
 */
router.patch(
  "/:id",
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    // Scoped by `userId` in the query itself: a schedule belonging to someone
    // else is not found rather than found-and-refused.
    const doc = await ScheduledPost.findOne({ _id: req.params.id, userId: req.userId });
    if (!doc) throw notFound("schedule not found");

    // The network is fixed at creation. Changing it would revalidate the caption
    // length and the image requirement against different rules, and the sensible
    // way to move a post between networks is to write it for the one it is going
    // to — so a request to switch is refused rather than half-applied.
    if (req.body?.provider !== undefined && readProvider(req.body.provider) !== doc.provider) {
      throw badRequest("A scheduled post cannot be moved to a different network.");
    }

    const provider = doc.provider as PostProvider;

    if (req.body?.caption !== undefined) doc.caption = readCaption(req.body.caption, provider);
    if (req.body?.name !== undefined) {
      doc.name = String(req.body.name).trim() || doc.name;
    }

    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!POST_STATUSES.includes(status as never)) {
        throw badRequest(`status must be one of ${POST_STATUSES.join(", ")}`);
      }
      const next = status as (typeof POST_STATUSES)[number];
      // Putting a failed post back on the schedule is a retry, so the failure
      // it carries is spent. Only on the way *into* `active`: pausing one
      // should not quietly hide why it did not go out.
      if (next === "active" && doc.status !== "active" && doc.lastStatus === "failed") {
        doc.set({ lastStatus: "", lastError: "" });
      }
      doc.status = next;
    }

    if (req.body?.image !== undefined || req.body?.images !== undefined) {
      // Every id the post held before this edit, so anything the new set no
      // longer references can be cleaned up afterwards.
      const previousIds = [doc.imagePublicId, ...doc.extraImages.map((i) => i.publicId)]
        .filter(Boolean);

      const { imageUrl, imagePublicId, extraImages } = await storeImages(
        readImages(req.body),
        req.userId!,
        { imageUrl: doc.imageUrl, imagePublicId: doc.imagePublicId },
        // From the document: the format is fixed once a post exists, so an
        // edit that replaces a story's image still fits it to 9:16.
        doc.format as PostFormat,
      );
      // Clearing the image is valid on LinkedIn and impossible on Instagram,
      // which has no text-only post. Refused before any old file is deleted.
      if (provider === "instagram" && !imageUrl) {
        throw badRequest("Instagram posts need an image.");
      }

      doc.imageUrl = imageUrl;
      doc.imagePublicId = imagePublicId;
      doc.set("extraImages", extraImages);

      // Only after the replacements are safely stored, and only for files the
      // post no longer points at. An empty id alongside a surviving URL means
      // "unknown", not "different" — treating those as different is what
      // deleted the asset a schedule still referenced.
      const keptIds = new Set([imagePublicId, ...extraImages.map((i) => i.publicId)].filter(Boolean));
      for (const id of previousIds) {
        if (!keptIds.has(id)) await deleteImage(id).catch(() => {});
      }
    }

    // The schedule is all-or-nothing: changing one field without the others
    // would compute a next run from a mix of old and new values.
    if (
      req.body?.mode !== undefined
      || req.body?.runAt !== undefined
      || req.body?.frequency !== undefined
      || req.body?.hour !== undefined
    ) {
      const schedule = readSchedule({
        mode: req.body.mode ?? doc.mode,
        runAt: req.body.runAt ?? doc.runAt?.toISOString(),
        frequency: req.body.frequency ?? doc.frequency,
        hour: req.body.hour ?? doc.hour,
        minute: req.body.minute ?? doc.minute,
        weekday: req.body.weekday ?? doc.weekday,
        dayOfMonth: req.body.dayOfMonth ?? doc.dayOfMonth,
        timezone: req.body.timezone ?? doc.timezone,
      });
      // Switching an existing post onto a cadence is the same entitlement as
      // creating one that way, so it is checked here too rather than only at
      // create — otherwise the limit is one edit away from being bypassed.
      if (schedule.mode === "repeat" && doc.mode !== "repeat") {
        const repeats = await canUseRepeatingPosts(String(doc.workspaceId));
        if (!repeats.ok) throw forbidden(repeats.error);
      }

      // Cleared rather than left behind, so a post switched from one mode to the
      // other does not keep a stale time from the mode it left.
      doc.set(schedule.mode === "once" ? { frequency: undefined } : { runAt: null });
      doc.set(schedule);
      doc.nextRunAt = firstRun(schedule);
      // Rescheduling a post that already went out is how someone reposts it;
      // it has to leave `sent` or the runner will never look at it again.
      if (doc.status === "sent") doc.status = "active";
      // A new time is a fresh attempt, so the previous failure stops being the
      // post's headline. Left behind, `lastStatus` keeps the row reading
      // "Failed" — with the old reason — long after the cause was fixed.
      if (doc.lastStatus === "failed") doc.set({ lastStatus: "", lastError: "" });
    }

    // Resuming a paused repeat needs a fresh slot: the stored one is in the past
    // by however long it was paused, and would fire on the next tick. A one-off
    // is left alone — its time is a specific moment, not a cadence, and moving
    // it silently would publish at a time nobody chose.
    if (doc.status === "active" && doc.mode === "repeat" && doc.nextRunAt.getTime() <= Date.now()) {
      doc.nextRunAt = computeNextRun({
        frequency: doc.frequency,
        hour: doc.hour,
        minute: doc.minute,
        timezone: doc.timezone,
        weekday: doc.weekday,
        dayOfMonth: doc.dayOfMonth,
      });
    }

    await doc.save();
    res.json(publicPost(doc));
  }),
);

/**
 * Publish a schedule right now.
 *
 * An extra send rather than a rescheduling: the cadence and `nextRunAt` are left
 * exactly as they were, so a weekly post sent by hand today still goes out on
 * its usual day. That is the behaviour someone testing a schedule wants — see
 * `publishNow`.
 *
 * POST because it publishes, and scoped like every other route here: the
 * schedule must belong to the caller, since it publishes under their token.
 */
router.post(
  "/:id/publish",
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const doc = await ScheduledPost.findOne({ _id: req.params.id, userId: req.userId });
    if (!doc) throw notFound("schedule not found");

    try {
      const postUrl = await publishNow(doc);
      res.json({ ...publicPost(doc), postUrl });
    } catch (e) {
      // `publishNow` throws messages already written for the user — a dead
      // token, a missing scope, a 404 on the stored image. They are the useful
      // half of the response, so they are passed through rather than flattened
      // into a generic failure.
      throw badRequest((e as Error).message);
    }
  }),
);

/**
 * Remove one row from the Sent history.
 *
 * The record only. The post itself stays up on LinkedIn or Instagram — this is
 * "stop listing it here", not "unpublish it", and the studio says so before
 * asking. Deleting the real post is a separate decision with a different blast
 * radius, and conflating the two behind one button is how a tidy-up becomes an
 * accident.
 *
 * The Cloudinary asset is deliberately left alone. A run's image is the same
 * file the schedule still points at, so deleting it here would break a
 * schedule that is due to publish again — `SocialPostRun` copies the URL
 * precisely because the two have separate lifetimes.
 *
 * Registered before `/:id` below: Express matches in order, and that route
 * would otherwise swallow this one with `id` set to "runs".
 */
router.delete(
  "/runs/:id",
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    // Scoped by `userId` in the query: someone else's run is not found rather
    // than found-and-refused.
    const run = await SocialPostRun.findOne({ _id: req.params.id, userId: req.userId });
    if (!run) throw notFound("post not found");

    await run.deleteOne();
    res.json({ deleted: true });
  }),
);

/** Delete a schedule, and the image it owns. */
router.delete(
  "/:id",
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const doc = await ScheduledPost.findOne({ _id: req.params.id, userId: req.userId });
    if (!doc) throw notFound("schedule not found");

    // Best-effort: an orphaned Cloudinary asset is not worth failing the delete
    // the user actually asked for. Every slide of a carousel, not just the first.
    for (const id of [doc.imagePublicId, ...doc.extraImages.map((i) => i.publicId)]) {
      if (id) await deleteImage(id).catch(() => {});
    }

    await doc.deleteOne();
    res.json({ deleted: true });
  }),
);

export default router;
