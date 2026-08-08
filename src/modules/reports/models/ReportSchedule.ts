import mongoose, { Schema } from "mongoose";
import { nanoid } from "nanoid";

/**
 * A recurring emailed report: analytics and SEO for one or more sites, sent to
 * the owner and anyone they choose to add.
 *
 * The recipient list is the reason several decisions here look defensive. Most
 * addresses on it will never have an account — a client, a manager, an agency's
 * customer — so this is the one place the product sends mail to people who
 * never agreed to hear from us. Each recipient therefore carries its own
 * unsubscribe token, and removing yourself must not require logging in.
 *
 * `nextRunAt` is stored rather than recomputed from `lastSentAt` on every pass,
 * so the cron's "what is due" query is a single indexed range scan instead of a
 * full-collection filter, and a schedule that was disabled for a month doesn't
 * fire a burst of catch-up sends when re-enabled.
 */

/**
 * The frequencies a user may choose. Daily is the floor on purpose: no
 * schedule may send more than once in 24 hours.
 *
 * Two independent things enforce that, because one of them is a config file
 * someone could edit in a hurry: `MIN_INTERVAL_MS` below is checked against
 * every computed run time, and the cron itself only fires once a day.
 */
export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** Hard floor between two sends of the same schedule. */
export const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const recipientSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    /**
     * Per-recipient, not per-schedule: one person unsubscribing must not
     * silently stop everyone else's copy, and the token in a forwarded email
     * must not let the forwardee cancel the original recipient.
     */
    unsubToken: { type: String, required: true, default: () => nanoid(32) },
    /** Set when they unsubscribe. Kept on the list rather than deleted, so re-adding them by hand can't quietly resubscribe someone who opted out. */
    unsubscribedAt: { type: Date },
  },
  { _id: false }
);

/**
 * A WhatsApp destination.
 *
 * Separate from `recipients` rather than a `type` field on it, because the two
 * differ in more than transport: a phone number has no unsubscribe link to
 * follow (there is no page to open from a chat), so opting out is a reply to
 * the sender or a change made by the owner. Modelling them as one list would
 * mean carrying an unsubscribe token that can never be used.
 */
const phoneRecipientSchema = new Schema(
  {
    /** Digits only, country code first — normalised on save by `lib/whatsapp.ts`. */
    phone: { type: String, required: true, trim: true },
    /** Free-text note so an owner can tell two numbers apart. */
    label: { type: String, trim: true, maxlength: 60 },
    /** Set when the owner removes them from delivery without deleting the row. */
    optedOutAt: { type: Date },
  },
  { _id: false }
);

const reportScheduleSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    /** Public tracking keys of the sites covered. Empty means every site in the workspace at send time. */
    siteIds: { type: [String], default: [] },
    name: { type: String, required: true, trim: true, maxlength: 80 },

    frequency: { type: String, enum: FREQUENCIES, required: true },
    recipients: { type: [recipientSchema], default: [] },
    /**
     * WhatsApp destinations. Empty on every schedule that predates the channel,
     * which is exactly the right default — an existing report must not start
     * messaging phones because the feature shipped.
     */
    phoneRecipients: { type: [phoneRecipientSchema], default: [] },
    /**
     * Which channels this report goes out on.
     *
     * Defaulting to email alone keeps existing schedules behaving as they did.
     * Both can be on at once: the same numbers by email with the spreadsheet,
     * and a short version on WhatsApp.
     */
    channels: {
      email: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
    },

    /**
     * What goes in the email. All three off would send a greeting and nothing
     * else, so the route requires at least one.
     */
    include: {
      analytics: { type: Boolean, default: true },
      seo: { type: Boolean, default: true },
      /** A link to the live shared dashboard. Requires the workspace's share link to be on. */
      dashboardLink: { type: Boolean, default: false },
      /**
       * The plain-language summary of the period, written by a model.
       *
       * On by default, including for schedules created before it existed: it is
       * the part of the report most recipients actually read, and a summary
       * nobody discovers is a summary nobody benefits from. Off is a real
       * choice, not a fallback — an agency mailing reports to its own clients
       * may not want machine-written commentary going out under its name.
       *
       * Independent of `analytics`: the summary is written from those figures,
       * so it cannot appear without them, but a report can carry the numbers
       * without an interpretation of them.
       */
      aiSummary: { type: Boolean, default: true },
    },
    /** Attach the full data as a spreadsheet alongside the summary in the body. */
    attachXlsx: { type: Boolean, default: true },

    /**
     * Credential for the hosted view of this report.
     *
     * Its own token rather than the workspace share token: a report link handed
     * to one client must not also unlock the full live dashboard, and revoking
     * one must not revoke the other. Prefixed so a glance at a log line says
     * what kind of secret it is.
     */
    viewToken: { type: String, required: true, unique: true, default: () => `rp_${nanoid(28)}`, index: true },

    enabled: { type: Boolean, default: true },
    lastSentAt: { type: Date },
    /**
     * When this schedule is next due. The cron matches on this alone, so a
     * paused schedule simply stops being selected rather than needing a second
     * condition in the query.
     */
    nextRunAt: { type: Date, required: true, index: true },
    /** Why the last run failed, if it did. Cleared on the next success. */
    lastError: { type: String },
  },
  { timestamps: true }
);

/** The cron's only query: due, and switched on. */
reportScheduleSchema.index({ enabled: 1, nextRunAt: 1 });

export const ReportSchedule = mongoose.model("ReportSchedule", reportScheduleSchema);

/**
 * When a schedule of this frequency should next fire, counted from `from`.
 *
 * Deliberately anchored to 08:00 UTC rather than the moment the schedule was
 * created: a weekly report that arrives at 03:14 because that's when someone
 * happened to click Save is worse than one that reliably lands in the morning.
 *
 * Hobby-tier Vercel Cron fires once a day with up to an hour of drift, so the
 * real arrival is "morning-ish" — close enough for a digest, and the reason
 * this is a date calculation rather than a promise about the minute.
 */
export function computeNextRun(frequency: Frequency, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setUTCHours(8, 0, 0, 0);

  // Anchoring can land in the past (it's already past 08:00 today), so always
  // advance at least one period from `from` rather than scheduling a run that
  // is instantly overdue.
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);

  if (frequency === "weekly") {
    // Next Monday. A weekly report covering "last week" is only meaningful if
    // it arrives after the week it describes has ended.
    const daysUntilMonday = (8 - next.getUTCDay()) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + daysUntilMonday - 1);
  } else if (frequency === "monthly") {
    // The 1st of next month, same reasoning as weekly.
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
  }

  // The 24h floor, enforced on the result rather than trusted from the
  // frequency. Anchoring to 08:00 can land less than a day out — a daily
  // schedule saved at 07:00 would otherwise be due in an hour — and this is the
  // one line that has to hold if a shorter frequency is ever added above.
  const earliest = new Date(from.getTime() + MIN_INTERVAL_MS);
  return next < earliest ? earliest : next;
}

/** The analytics window a report of this frequency covers. */
export function rangeForFrequency(frequency: Frequency): "24h" | "7d" | "30d" {
  if (frequency === "daily") return "24h";
  return frequency === "weekly" ? "7d" : "30d";
}
