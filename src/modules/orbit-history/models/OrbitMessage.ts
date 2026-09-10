import mongoose, { Schema } from "mongoose";

/**
 * One turn in a saved Orbit conversation.
 *
 * Both sides of an exchange are rows here, ordered by `seq` within a
 * conversation rather than by timestamp — two turns written in the same
 * millisecond must still come back question-then-answer.
 *
 * The question is stored even when the answer failed. A question nobody could
 * answer is the most useful row in this collection: it is either a gap in the
 * knowledge base or a bug, and both are invisible if only successes are kept.
 *
 * What is deliberately *not* here: the page context the browser can attach to a
 * question. That is up to twelve thousand characters of arbitrary page text per
 * turn, it is not what the user wrote, and keeping it would quietly turn a
 * transcript store into a copy of whatever they were looking at.
 */
const orbitMessageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "OrbitConversation",
      required: true,
      index: true,
    },

    /**
     * Denormalised from the conversation so a workspace's turns can be counted
     * or removed without a join. Set on the server from the parent document,
     * never from the request.
     */
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },

    /** Position in the thread, from 0. Ordering key; ties are impossible. */
    seq: { type: Number, required: true },

    role: { type: String, enum: ["user", "assistant"], required: true },

    /**
     * Capped at the same 4000 characters the route already truncates history
     * to before sending it to the model, so what is stored is what the next
     * question would have carried.
     */
    content: { type: String, required: true, maxlength: 4000 },

    /**
     * The follow-ups offered after this answer. Kept on the turn that produced
     * them so a restored conversation shows what was on offer at each point,
     * matching how the live panel renders them.
     */
    suggestions: { type: [String], default: [] },

    /**
     * True when this assistant turn is an error rather than an answer.
     *
     * Restored conversations render it as a failure, and it is never sent back
     * to the model as history — the same rule the browser already follows.
     */
    failed: { type: Boolean, default: false },

    /**
     * Which model produced this turn. Per-message rather than per-conversation
     * because the chain falls through on a rate limit, so one thread can have
     * turns from several models.
     */
    model: { type: String, trim: true, maxlength: 120, default: "" },
    modelLabel: { type: String, trim: true, maxlength: 120, default: "" },

    /** Round-trip time for the answer, in ms. Zero on user turns. */
    latencyMs: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// The only read: one conversation, in order.
orbitMessageSchema.index({ conversationId: 1, seq: 1 });

export const OrbitMessage = mongoose.model("OrbitMessage", orbitMessageSchema);
