import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * One LinkedIn post, as actually published.
 *
 * `ScheduledPost` describes an *intention* — what to publish and when — and
 * keeps only the outcome of its most recent run in `lastPostUrl` and
 * `lastStatus`. That is enough to show "did the last one work?" beside a
 * schedule, and not enough for anything else: a weekly post that has gone out
 * ten times leaves one URL and a count, with the other nine publishes
 * unrecoverable. The Sent tab needs the opposite shape — a row per publish,
 * ordered by when it happened, independent of the schedule that caused it.
 *
 * So this collection is append-only history. A row is written every time a post
 * is published, from any path: the cron runner, "publish now" in the studio, or
 * the Share Panel's one-off post, which has no `ScheduledPost` behind it at all.
 *
 * ## Why the caption is copied rather than referenced
 *
 * Editing a schedule rewrites its caption and replaces its image. A Sent tab
 * that read those through a reference would show every past post as though it
 * had always said what the schedule says today — history rewritten by an edit
 * that was only ever meant to change the *next* post. The content is therefore
 * denormalised here at publish time and never touched again.
 *
 * ## What this collection cannot hold
 *
 * Only posts this application published. Anything the member wrote directly on
 * LinkedIn is invisible: reading a member's own feed needs `r_member_social`,
 * which comes from a product this app has not been granted. See
 * `LINKEDIN_READ_SCOPES` for the full picture and for the fallback that keeps
 * connecting from breaking while that remains true.
 */

/**
 * How a post came to be published.
 *
 * Recorded because the three paths behave differently and the studio says so:
 * a `schedule` row fired on its own, a `manual` row was a "publish now" on a
 * schedule, and a `share` row came from the Share Panel and has no schedule
 * behind it — so it offers no "view schedule" link.
 */
export const POST_SOURCES = ["schedule", "manual", "share"] as const;
export type PostSource = (typeof POST_SOURCES)[number];

/**
 * Whether the publish worked.
 *
 * Failures are kept rather than discarded: "nothing was published on Tuesday"
 * and "Tuesday's post was rejected because the token had expired" are different
 * facts, and only the second one tells the user what to do.
 */
export const RUN_STATUSES = ["published", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Engagement figures for one post.
 *
 * Every count is nullable and defaults to null rather than 0, which is the
 * whole point of the subdocument. A post published four minutes ago genuinely
 * has no impression data yet, and a post whose statistics this app is not
 * permitted to read never will — rendering either as "0 impressions" states
 * something false. Null means "not known"; the Sent tab shows a dash.
 */
const statsSchema = new Schema(
  {
    impressions: { type: Number, default: null },
    /** Distinct members reached, which LinkedIn reports separately from impressions. */
    uniqueImpressions: { type: Number, default: null },
    likes: { type: Number, default: null },
    comments: { type: Number, default: null },
    shares: { type: Number, default: null },
    clicks: { type: Number, default: null },
    /**
     * LinkedIn's own engagement rate, as a fraction — 0.05 is the "5%" the UI
     * shows. Stored as returned rather than recomputed: their denominator is not
     * documented precisely enough to reproduce, and a number that disagrees with
     * what LinkedIn itself displays is worse than no number.
     */
    engagement: { type: Number, default: null },
    /** When these figures were last refreshed. Null means never fetched. */
    fetchedAt: { type: Date, default: null },
    /**
     * Why there are no figures, when there are none.
     *
     * `scope` is the ordinary case today: this deployment has no analytics
     * permission, so the refresh job never even asks. `pending` means LinkedIn
     * was asked and had nothing yet, which is normal for the first hour or so
     * after publishing. Empty means the figures above are real.
     */
    unavailable: { type: String, enum: ["", "scope", "pending", "error"], default: "scope" },
  },
  { _id: false },
);

const socialPostRunSchema = new Schema(
  {
    /**
     * Which network this went out on.
     *
     * Defaulted to `linkedin` so every row written before Instagram existed
     * reads correctly without a backfill. The statistics refresh filters on it:
     * LinkedIn's analytics API is the only one wired up, and handing it an
     * Instagram media id would be a guaranteed error on every tick.
     */
    provider: { type: String, enum: ["linkedin", "instagram"], required: true, default: "linkedin" },

    /** Whose account this went out on. */
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /**
     * The workspace the post was about.
     *
     * Optional: a Share Panel post is about whatever card was open and does not
     * always carry one, and refusing to record a publish because it lacked a
     * workspace would lose the very history this collection exists to keep.
     */
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },
    /** The schedule that produced this, when there was one. */
    scheduledPostId: {
      type: Schema.Types.ObjectId,
      ref: "ScheduledPost",
      default: null,
      index: true,
    },

    source: { type: String, enum: POST_SOURCES, required: true, default: "schedule" },
    status: { type: String, enum: RUN_STATUSES, required: true, default: "published" },

    /**
     * LinkedIn's identifier for the post — `urn:li:share:...` or
     * `urn:li:ugcPost:...`.
     *
     * The single most important field here, and the reason this collection was
     * added when it was. It is the only key LinkedIn's statistics APIs accept:
     * a permalink cannot be exchanged for one, and until now the publish path
     * read the URN out of the response header and then dropped it on the floor.
     * Every post published before this existed is therefore permanently beyond
     * the reach of any stats backfill.
     *
     * Empty on a failed publish, and on a success where LinkedIn returned no
     * identifier — rare, but the post has still gone out and is worth recording.
     */
    postUrn: { type: String, trim: true, default: "", index: true },
    /** The viewable permalink, when the URN maps to one. */
    postUrl: { type: String, trim: true, default: "" },

    /**
     * Feed post or story.
     *
     * Kept because it changes how the row reads rather than only how it was
     * sent: a story's permalink stops working 24 hours after it went out, and
     * a Sent tab that offered a dead "Go to post" link with no explanation
     * would look like the link was broken rather than the story expired.
     */
    format: { type: String, enum: ["feed", "story"], required: true, default: "feed" },

    /** The post exactly as published. Copied, never referenced — see above. */
    caption: { type: String, default: "" },
    imageUrl: { type: String, default: "" },

    /** The schedule's name at the time, for a row that can no longer reach it. */
    name: { type: String, trim: true, default: "" },

    /**
     * When it went out.
     *
     * Distinct from `createdAt`, which is when the row was written — the two
     * differ for a backfilled row, where the publish happened long before.
     */
    publishedAt: { type: Date, required: true, index: true },

    /** Why it failed, in the words already shown to the user. Empty on success. */
    error: { type: String, default: "" },

    stats: { type: statsSchema, default: () => ({}) },
  },
  { timestamps: true },
);

/**
 * The Sent tab's query: one user's posts, newest first.
 *
 * Compound in this order because that is how it is read — the user narrows to
 * their own rows, then the date orders them and serves the pagination cursor
 * without a sort in memory.
 */
socialPostRunSchema.index({ userId: 1, publishedAt: -1 });

/**
 * The stats refresh job's query: rows worth asking LinkedIn about, oldest
 * refresh first, so a capped tick works through the backlog fairly instead of
 * re-fetching the same recent handful.
 */
socialPostRunSchema.index({ status: 1, "stats.fetchedAt": 1, publishedAt: -1 });

/**
 * One row per LinkedIn post.
 *
 * Sparse and partial together: a failed publish has no URN and several may
 * share the empty string, which a plain unique index would reject. This makes
 * the guarantee apply only to rows that actually carry one — which is where it
 * matters, since the backfill and the publish path can both write the same post.
 */
socialPostRunSchema.index(
  { postUrn: 1 },
  { unique: true, partialFilterExpression: { postUrn: { $type: "string", $gt: "" } } },
);

export type SocialPostRunDoc = InferSchemaType<typeof socialPostRunSchema>;
export const SocialPostRun = mongoose.model("SocialPostRun", socialPostRunSchema);
