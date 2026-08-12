import mongoose, { Schema } from "mongoose";

/**
 * One person's answers to one form.
 *
 * This is the first collection in the product that holds personal data by
 * definition — names, email addresses, phone numbers — where `Event` is
 * deliberately cookieless and non-identifying. Same database, different data
 * class, so the rules that apply here are not the ones that apply to events:
 * retention is per workspace, a workspace delete must hard-delete these rows,
 * and `ipHash` never leaves the server.
 *
 * Nothing stored here is ever rendered as HTML — not in the dashboard, not in
 * the notification email, not in the CSV. The whole XSS story for forms is that
 * one sentence, and it is load-bearing.
 */
const submissionSchema = new Schema(
  {
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    /**
     * Denormalised deliberately: quota counting and the retention sweep must
     * not join through `Form` on every write and every pass.
     */
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },

    /** `{ [fieldKey]: value }`, keys validated against the form's fields on ingest. */
    data: { type: Schema.Types.Mixed, default: {} },

    /**
     * Attribution handles, null in v1.
     *
     * The hosted form runs on our domain, so there is no shared `visitorHash`
     * with the customer's `tracker.js` and nothing fills these yet. They exist
     * now so the later `?v=` handoff — the thing that makes "this lead came
     * from google/cpc and read four pages" possible — drops in without a
     * migration over a collection of leads.
     */
    visitorHash: { type: String, default: null, index: true },
    sessionId: { type: String, default: null },

    referrer: { type: String, default: "", maxlength: 500 },
    utm: {
      source: { type: String, default: "" },
      medium: { type: String, default: "" },
      campaign: { type: String, default: "" },
    },

    /**
     * HMAC of the submitter's IP. Never returned by any endpoint — it exists to
     * rate-limit a flood, not to be looked at.
     */
    ipHash: { type: String, default: "", index: true },
    userAgent: { type: String, default: "", maxlength: 300 },

    /** Hash over the normalised answers, for exact-repeat suppression. */
    dedupHash: { type: String, default: "", index: true },
    /** Present when `dedupFieldKey` is set — the normalised identifying value. */
    dedupValue: { type: String, default: "", index: true },

    /**
     * Stored while the workspace was over its submission quota.
     *
     * The row is kept, not refused: a dropped analytics event is a gap in a
     * chart, but a dropped lead is lost revenue the customer will never forgive.
     * The flag is what turns notifications off and the upgrade banner on.
     */
    overQuota: { type: Boolean, default: false },
    /**
     * Set when the form was above its hourly ceiling — still accepted, but
     * marked so a flood is visibly a flood rather than a hundred real leads.
     */
    flagged: { type: Boolean, default: false },
    /** Why it was flagged, for the dashboard's tooltip. Never shown to the submitter. */
    flagReason: { type: String, default: "" },

    /** Notification state, so a retry cannot mail the same row twice. */
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The submissions table: one form, newest first. */
submissionSchema.index({ formId: 1, createdAt: -1 });
/** Per-IP rate limiting, and the per-form hourly ceiling. */
submissionSchema.index({ formId: 1, ipHash: 1, createdAt: -1 });
/** The retention sweep: one workspace's rows older than a cutoff. */
submissionSchema.index({ workspaceId: 1, createdAt: 1 });

export const Submission = mongoose.model("Submission", submissionSchema);
