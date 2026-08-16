import mongoose, { Schema } from "mongoose";

/**
 * One lead-form response.
 *
 * `workspaceId` is denormalised from `Form` deliberately: quota counting and
 * retention sweeps run against every submission in a workspace and must not
 * join through `Form` on every write or every sweep pass.
 *
 * `visitorHash`/`sessionId` stay nullable in v1 — the hosted form page has no
 * shared origin with the customer's `tracker.js`, so there is nothing to join
 * yet. Left in place so a later JS-embed handoff drops in without a migration.
 */
const submissionSchema = new Schema(
  {
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    /** `{ [fieldKey]: value }`. Never rendered as HTML anywhere it is read back. */
    data: { type: Schema.Types.Mixed, required: true },
    visitorHash: { type: String, default: null },
    sessionId: { type: String, default: null },
    referrer: { type: String, maxlength: 500 },
    utm: {
      source: { type: String, maxlength: 200 },
      medium: { type: String, maxlength: 200 },
      campaign: { type: String, maxlength: 200 },
    },
    /**
     * HMAC of the submitter's IP. Never returned by any endpoint — it exists
     * to rate-limit a flood, not to be looked at, same convention noted at
     * `admin.ts:917` for the equivalent field on `ContactMessage`.
     */
    ipHash: { type: String, required: true, index: true },
    userAgent: { type: String, maxlength: 300 },
    /** HMAC over the normalised `data{}}`, for exact-repeat detection. */
    dedupHash: { type: String, required: true, index: true },
    /** True once the form's per-hour ceiling was exceeded. Still stored, never dropped. */
    overQuota: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

submissionSchema.index({ formId: 1, createdAt: -1 });
// Rate-limit and dedup-window queries both filter by ipHash/dedupHash within a
// recent time slice — pairing each with createdAt keeps those scans indexed.
submissionSchema.index({ formId: 1, ipHash: 1, createdAt: -1 });
submissionSchema.index({ formId: 1, dedupHash: 1, createdAt: -1 });

export const Submission = mongoose.model("Submission", submissionSchema);
