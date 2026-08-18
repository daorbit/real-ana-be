import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * A post the user wrote once, to be published on a repeating schedule.
 *
 * The content is authored in the studio and stored here whole: the caption as
 * text, the image as a Cloudinary URL. Nothing is generated at publish time.
 * That is a deliberate split — the cron runner has no browser to draw a canvas
 * in and no business spending Orbit quota unattended, so its only job is to
 * take finished content and hand it to LinkedIn.
 *
 * Shaped after `ReportSchedule`, which solves the same problem for emailed
 * reports: a cadence, a next-run stamp, and a record of how the last run went.
 * Keeping the two recognisably alike means the cron runner below reads the same
 * way as the one for reports.
 */

/** The cadences offered. Deliberately coarse — this posts publicly. */
export const POST_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type PostFrequency = (typeof POST_FREQUENCIES)[number];

export const POST_STATUSES = ["active", "paused"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

const scheduledPostSchema = new Schema(
  {
    /**
     * Who publishes it. The LinkedIn token is looked up from this at run time
     * rather than copied here, so disconnecting the account stops every
     * schedule attached to it at once.
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /**
     * Which workspace the post is about. Kept so the studio can group schedules
     * by workspace and so deleting a workspace can take its schedules with it.
     */
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    /** What the user called it, for their own list. Not published. */
    name: { type: String, required: true, trim: true },

    /** The post body, exactly as it will appear. LinkedIn's cap is 3000. */
    caption: { type: String, required: true, trim: true, maxlength: 3000 },

    /**
     * The image, already uploaded to Cloudinary by the studio.
     *
     * A URL rather than bytes: the studio uploads once at save time, and the
     * runner fetches it when publishing. Optional — a text post is valid.
     */
    imageUrl: { type: String, trim: true, default: "" },
    /** Cloudinary's handle, so replacing or deleting a schedule can clean up. */
    imagePublicId: { type: String, trim: true, default: "" },

    frequency: { type: String, enum: POST_FREQUENCIES, required: true },
    /**
     * Local hour and minute the user chose, with the zone they chose it in.
     *
     * Stored as parts rather than a UTC timestamp because a cadence is a wall
     * clock promise: "every Monday at 9am" must stay 9am across a daylight
     * saving change, which a fixed UTC offset would not.
     */
    hour: { type: Number, required: true, min: 0, max: 23 },
    minute: { type: Number, required: true, min: 0, max: 59, default: 0 },
    /** IANA zone. Empty falls back to UTC at scheduling time. */
    timezone: { type: String, trim: true, default: "UTC" },
    /** 0-6, Sunday first. Weekly only. */
    weekday: { type: Number, min: 0, max: 6, default: 1 },
    /** 1-28. Monthly only, capped at 28 so every month has the day. */
    dayOfMonth: { type: Number, min: 1, max: 28, default: 1 },

    status: { type: String, enum: POST_STATUSES, required: true, default: "active" },

    /**
     * When this is next due, in UTC.
     *
     * Precomputed rather than derived on every cron tick: the runner's query is
     * then a single indexed range scan over due rows, instead of loading every
     * schedule and working out cadences in application code.
     */
    nextRunAt: { type: Date, required: true, index: true },

    lastRunAt: { type: Date, default: null },
    /** Outcome of the last attempt, so the studio can show it without guessing. */
    lastStatus: { type: String, enum: ["ok", "failed", ""], default: "" },
    /**
     * Why the last run failed, in the words shown to the user.
     *
     * Never a raw LinkedIn response — the publish path maps API failures onto
     * plain sentences before they reach here.
     */
    lastError: { type: String, default: "" },
    /** The permalink of the most recent successful post, when there was one. */
    lastPostUrl: { type: String, default: "" },
    /** Successful publishes, for the list view. */
    postCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * The runner's query: active schedules that are due.
 *
 * Compound and in this order because that is how it is read — status narrows to
 * a small subset, then the date range scans it.
 */
scheduledPostSchema.index({ status: 1, nextRunAt: 1 });

export type ScheduledPostDoc = InferSchemaType<typeof scheduledPostSchema>;
export const ScheduledPost = mongoose.model("ScheduledPost", scheduledPostSchema);
