import mongoose, { Schema, Types } from "mongoose";

/**
 * A widget placed on the home grid. Array order is the on-screen order, so
 * position needs no field of its own.
 */
const placedSchema = new Schema(
  {
    id: { type: String, required: true },
    span: { type: Number, required: true, enum: [1, 2, 3, 4] },
  },
  { _id: false }
);

const workspaceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    /**
     * Undefined means "never customised" — the client falls back to its own
     * defaults. An empty array is a real choice (the user removed every widget)
     * and must survive a reload, so the two cannot be collapsed into one.
     */
    homeLayout: { type: [placedSchema], default: undefined },

    /**
     * Public share link.
     *
     * `shareToken` is the entire credential for an unauthenticated read-only
     * view, so it is a long random string rather than anything derived from
     * the workspace id — a guessable token would expose a customer's traffic
     * to anyone who could enumerate ids.
     *
     * Sparse, because most workspaces never share: a non-sparse unique index
     * would collide on the second null.
     */
    shareToken: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true,
    },
    /**
     * Kept separate from the token so turning sharing off does not throw the
     * token away — the owner can re-enable the same link. Regenerating is the
     * deliberate act that invalidates old links.
     */
    shareEnabled: { type: Boolean, default: false },
    /**
     * Which panels the public dashboard shows.
     *
     * Owner-controlled rather than fixed, because the panels differ in how
     * sensitive they are: headline counts are harmless, but page paths can
     * expose internal URLs (/admin/invoices/acme-corp) that the person sharing
     * a traffic summary never intended to publish.
     */
    sharePanels: {
      totals: { type: Boolean, default: true },
      trend: { type: Boolean, default: true },
      pages: { type: Boolean, default: true },
      sources: { type: Boolean, default: true },
      countries: { type: Boolean, default: true },
      devices: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

export const Workspace = mongoose.model("Workspace", workspaceSchema);
