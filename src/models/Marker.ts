import mongoose, { Schema } from "mongoose";

/**
 * A moment worth drawing on a chart: a deploy, a campaign launch, a price
 * change, an outage.
 *
 * Analytics answers "what happened" and is silent on "why". A drop on Tuesday
 * is a mystery until something on the page says a release shipped Tuesday
 * morning — so this exists to make every other chart causal rather than merely
 * descriptive, at the cost of one small collection.
 *
 * Written either from the dashboard by hand or from CI over the Platform API,
 * which is where it earns its keep: a deploy hook that posts here means the
 * markers appear without anyone remembering to add them.
 */
export const MARKER_KINDS = ["deploy", "campaign", "incident", "note"] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

const markerSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /**
     * Which sites this applies to. Empty means every site in the workspace —
     * the common case, since a deploy usually ships one product.
     */
    siteIds: { type: [String], default: [] },

    label: { type: String, required: true, trim: true, maxlength: 80 },
    /** Optional detail: a commit sha, a release note, a link. */
    description: { type: String, default: "", maxlength: 500 },

    kind: { type: String, enum: MARKER_KINDS, default: "deploy" },

    /**
     * When it happened — not when the row was written.
     *
     * Separate from `createdAt` because CI often reports a deploy minutes after
     * it went out, and a marker drawn at the wrong minute is worse than none:
     * it would blame a traffic change on the wrong release.
     */
    at: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// The dashboard's only read: markers for a workspace inside the visible window.
markerSchema.index({ workspaceId: 1, at: -1 });

export const Marker = mongoose.model("Marker", markerSchema);
