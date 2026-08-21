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

/**
 * Which network the post goes to.
 *
 * Mirrors `PROVIDERS` on `SocialConnection`, which is what the runner looks the
 * token up by. Defaulted to `linkedin` rather than being required, because every
 * row written before Instagram existed is a LinkedIn post and reading them must
 * not depend on a backfill having run.
 */
export const POST_PROVIDERS = ["linkedin", "instagram"] as const;
export type PostProvider = (typeof POST_PROVIDERS)[number];

/** The cadences offered. Deliberately coarse — this posts publicly. */
export const POST_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type PostFrequency = (typeof POST_FREQUENCIES)[number];

/**
 * How a post is timed.
 *
 * `once` is the ordinary case and the default: a distinct post, written for a
 * moment, published at a date and time the author picked. `repeat` exists for
 * genuinely evergreen content and is deliberately the exception — republishing
 * the same words on a cadence is what an audience reads as spam, and LinkedIn
 * itself deprioritises duplicate commentary.
 */
export const POST_MODES = ["once", "repeat"] as const;
export type PostMode = (typeof POST_MODES)[number];

/**
 * `sent` is terminal, and only a `once` post reaches it: there is no next slot
 * to advance to, so the runner marks it published rather than leaving a row
 * that is forever due.
 */
export const POST_STATUSES = ["active", "paused", "sent"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

const scheduledPostSchema = new Schema(
  {
 
    provider: { type: String, enum: POST_PROVIDERS, required: true, default: "linkedin" },

    /**
     * Who publishes it. The provider token is looked up from this at run time
     * rather than copied here, so disconnecting the account stops every
     * schedule attached to it at once.
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
 
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    /** What the user called it, for their own list. Not published. */
    name: { type: String, required: true, trim: true },

 
    caption: { type: String, required: true, trim: true, maxlength: 3000 },

 
    imageUrl: { type: String, trim: true, default: "" },
    imagePublicId: { type: String, trim: true, default: "" },

 
    extraImages: {
      type: [{
        url: { type: String, trim: true, required: true },
        publicId: { type: String, trim: true, default: "" },
        _id: false,
      }],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= 9,
        message: "A post can carry at most 10 images.",
      },
    },

 
    groupId: { type: String, trim: true, default: "", index: true },

    mode: { type: String, enum: POST_MODES, required: true, default: "once" },

    /**
     * The instant a `once` post publishes, in UTC.
     *
     * A real timestamp rather than wall-clock parts, because a single post is
     * pinned to a moment: "Tuesday the 24th at 14:20" does not need to survive
     * a daylight saving change the way a recurring cadence does. The zone the
     * author picked it in is still stored, so the studio can show it back to
     * them in their own clock.
     */
    runAt: { type: Date, default: null },

    /** Recurrence, used only when `mode` is "repeat". */
    frequency: { type: String, enum: POST_FREQUENCIES, default: "weekly" },
    /**
     * Local hour and minute the user chose, with the zone they chose it in.
     *
     * Stored as parts rather than a UTC timestamp because a cadence is a wall
     * clock promise: "every Monday at 9am" must stay 9am across a daylight
     * saving change, which a fixed UTC offset would not.
     */
    hour: { type: Number, min: 0, max: 23, default: 9 },
    minute: { type: Number, min: 0, max: 59, default: 0 },
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
