import { Router, Response } from "express";
import { ScheduledPost, POST_FREQUENCIES, POST_STATUSES } from "../../modules/social/models/ScheduledPost.js";
import { computeNextRun } from "../../modules/social/schedule-time.js";
import { SocialConnection } from "../../modules/identity/models/SocialConnection.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import {
  checkImageDataUrl, cloudinaryConfigured, deleteImage, uploadImage,
} from "../../infra/storage/cloudinary.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { dashboardCors } from "../middleware/cors.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/index.js";

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

/** LinkedIn's commentary cap. */
const MAX_CAPTION = 3000;
/** Generous for a feed image, and well under LinkedIn's own ceiling. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The fields safe to return. The Cloudinary public id is ours, not the client's. */
function publicPost(doc: InstanceType<typeof ScheduledPost>) {
  return {
    id: doc.id,
    workspaceId: String(doc.workspaceId),
    name: doc.name,
    caption: doc.caption,
    imageUrl: doc.imageUrl,
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
 * Validate and normalise the schedule fields of a request body.
 *
 * Returns the cadence in the shape the model and the time helper both expect.
 * Every bound is enforced here rather than left to Mongoose so the caller gets
 * a 400 naming the field instead of a 500 from a failed validator.
 */
function readSchedule(body: Record<string, unknown>) {
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
    frequency: frequency as (typeof POST_FREQUENCIES)[number],
    hour,
    minute,
    weekday,
    dayOfMonth,
    timezone: String(body.timezone ?? "UTC").trim() || "UTC",
  };
}

/** The caption, checked for presence and length. */
function readCaption(value: unknown): string {
  const caption = String(value ?? "").trim();
  if (!caption) throw badRequest("Caption cannot be empty.");
  if (caption.length > MAX_CAPTION) {
    throw badRequest(`Caption must be ${MAX_CAPTION} characters or fewer.`);
  }
  return caption;
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
): Promise<{ imageUrl: string; imagePublicId: string }> {
  if (!image) return { imageUrl: "", imagePublicId: "" };

  // Already-hosted images pass through untouched: an unchanged edit resends the
  // Cloudinary URL it was given rather than the original bytes.
  if (/^https?:\/\//i.test(image)) return { imageUrl: image, imagePublicId: "" };

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
  });

  return { imageUrl: uploaded.url, imagePublicId: uploaded.publicId };
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
    const [posts, conn] = await Promise.all([
      ScheduledPost.find({ userId: req.userId }).sort({ createdAt: -1 }),
      SocialConnection.findOne({ userId: req.userId, provider: "linkedin" })
        .select("name expiresAt"),
    ]);

    res.json({
      posts: posts.map(publicPost),
      linkedin: conn
        ? {
            connected: true,
            expired: conn.expiresAt.getTime() <= Date.now(),
            name: conn.name,
          }
        : { connected: false, expired: false, name: "" },
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

    const caption = readCaption(req.body?.caption);
    const schedule = readSchedule(req.body ?? {});
    const name = String(req.body?.name ?? "").trim() || "Scheduled post";
    const { imageUrl, imagePublicId } = await storeImage(
      String(req.body?.image ?? ""),
      req.userId!,
    );

    const doc = await ScheduledPost.create({
      userId: req.userId,
      workspaceId,
      name,
      caption,
      imageUrl,
      imagePublicId,
      ...schedule,
      status: "active",
      nextRunAt: computeNextRun(schedule),
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

    if (req.body?.caption !== undefined) doc.caption = readCaption(req.body.caption);
    if (req.body?.name !== undefined) {
      doc.name = String(req.body.name).trim() || doc.name;
    }

    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!POST_STATUSES.includes(status as never)) {
        throw badRequest(`status must be one of ${POST_STATUSES.join(", ")}`);
      }
      doc.status = status as (typeof POST_STATUSES)[number];
    }

    if (req.body?.image !== undefined) {
      const previous = doc.imagePublicId;
      const { imageUrl, imagePublicId } = await storeImage(
        String(req.body.image ?? ""),
        req.userId!,
      );
      doc.imageUrl = imageUrl;
      doc.imagePublicId = imagePublicId;
      // Only after the replacement is safely stored, and never for a file we
      // do not own.
      if (previous && previous !== imagePublicId) {
        await deleteImage(previous).catch(() => {});
      }
    }

    // The cadence is all-or-nothing: changing one field without the others
    // would compute a next run from a mix of old and new values.
    if (req.body?.frequency !== undefined || req.body?.hour !== undefined) {
      const schedule = readSchedule({
        frequency: req.body.frequency ?? doc.frequency,
        hour: req.body.hour ?? doc.hour,
        minute: req.body.minute ?? doc.minute,
        weekday: req.body.weekday ?? doc.weekday,
        dayOfMonth: req.body.dayOfMonth ?? doc.dayOfMonth,
        timezone: req.body.timezone ?? doc.timezone,
      });
      doc.set(schedule);
      doc.nextRunAt = computeNextRun(schedule);
    }

    // Resuming a paused schedule needs a fresh slot: the stored one is in the
    // past by however long it was paused, and would fire on the next tick.
    if (doc.status === "active" && doc.nextRunAt.getTime() <= Date.now()) {
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

/** Delete a schedule, and the image it owns. */
router.delete(
  "/:id",
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const doc = await ScheduledPost.findOne({ _id: req.params.id, userId: req.userId });
    if (!doc) throw notFound("schedule not found");

    // Best-effort: an orphaned Cloudinary asset is not worth failing the delete
    // the user actually asked for.
    if (doc.imagePublicId) await deleteImage(doc.imagePublicId).catch(() => {});

    await doc.deleteOne();
    res.json({ deleted: true });
  }),
);

export default router;
