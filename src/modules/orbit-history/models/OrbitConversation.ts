import mongoose, { Schema } from "mongoose";

/**
 * One saved Orbit conversation, belonging to a workspace.
 *
 * Deliberately outside `modules/orbit/`: that package is written to be lifted
 * out as an npm module and may not import a Mongo model or know that storage
 * exists. Persistence is a Quantalog decision about Quantalog's own workspaces,
 * so it lives here and the route wires the two together.
 *
 * Only the authenticated dashboard assistant is stored. The public assistant on
 * the marketing site stays in the browser — it is unauthenticated, there is no
 * consent step in front of it, and a transcript nobody can be shown or asked
 * about is not one worth keeping.
 *
 * Turns are a separate collection rather than an array on this document. A
 * conversation has no bound on its length, the list view reads only the header
 * fields, and an embedded array would mean loading every turn to render a list
 * of titles — and eventually meeting the 16MB document ceiling.
 */
const orbitConversationSchema = new Schema(
  {
    /**
     * The workspace that owns it. Orbit is metered per workspace, so the
     * transcript belongs to the same thing that paid for it — a colleague who
     * can already see the workspace's analytics can see its Orbit history.
     */
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },

    /**
     * The account that did the asking. Set from the session on the server,
     * never from the request body.
     *
     * Kept so the list can say who started a thread, and so a user's own
     * threads can be found when an account is deleted.
     */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /**
     * The first question, trimmed — what the list shows.
     *
     * Stored rather than derived on read: deriving it means loading the first
     * turn of every conversation to render a list, which is the exact read the
     * split into two collections exists to avoid.
     */
    title: { type: String, required: true, trim: true, maxlength: 160 },

    /** Kept current so the list can show length without counting turns. */
    messageCount: { type: Number, default: 0 },

    /**
     * When the last turn landed. The list sorts on this, not `createdAt` — a
     * thread returned to yesterday is more relevant than one started today and
     * abandoned.
     */
    lastMessageAt: { type: Date, default: Date.now, index: true },

    /**
     * The model that answered most recently. Informational, for the list; the
     * per-turn model is on the message, since a fallback can change it mid
     * conversation.
     */
    lastModel: { type: String, trim: true, maxlength: 120, default: "" },
    lastModelLabel: { type: String, trim: true, maxlength: 120, default: "" },

    /**
     * Hidden from the owner's list without being destroyed.
     *
     * A delete from the UI sets this. The rows still exist for a support
     * question about a bad answer, and the sweep that actually removes them is
     * a separate, deliberate job rather than a click.
     */
    deletedAt: { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// The list view: one workspace's live conversations, most recently active first.
orbitConversationSchema.index({ workspaceId: 1, deletedAt: 1, lastMessageAt: -1 });

export const OrbitConversation = mongoose.model("OrbitConversation", orbitConversationSchema);
