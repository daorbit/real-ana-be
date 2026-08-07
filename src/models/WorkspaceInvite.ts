import mongoose, { Schema } from "mongoose";
import { WORKSPACE_ROLES } from "./Membership.js";

/**
 * A pending invitation to join a workspace.
 *
 * Invites are addressed to an *email*, not a user id, because the whole point
 * is that the recipient may not have an account yet — they sign up through the
 * link and the invite is claimed on their first sign-in.
 *
 * `owner` is not an invitable role (guarded at the route): ownership transfers
 * are a different act with different consequences, not something to hand out
 * through an email link.
 */
const inviteSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    /** Lowercased so "Bob@x.com" and "bob@x.com" are one invite, not two. */
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    role: { type: String, enum: WORKSPACE_ROLES, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /**
     * The entire credential for accepting. Long and random for the same reason
     * as a share token: anyone holding it gains access to a customer's
     * analytics, so it must not be guessable from the workspace id or the
     * recipient's address.
     */
    token: { type: String, required: true, unique: true, index: true },

    /**
     * Invitations go stale — a mailbox is not a safe place to leave standing
     * access indefinitely, and an address can change hands. Expired invites are
     * refused at accept time and can be re-sent.
     */
    expiresAt: { type: Date, required: true },

    /**
     * When it was accepted. Kept rather than deleted so the members list can
     * show how someone got there, and so a link that has already been used
     * fails with "already accepted" instead of "not found".
     */
    acceptedAt: { type: Date, default: null },
    /** Who accepted. Normally the addressee, but see the accept route. */
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

/**
 * One outstanding invite per address per workspace.
 *
 * Partial, so it constrains only *pending* rows: re-inviting someone who
 * accepted and later left must be allowed, and a non-partial index would treat
 * the old accepted row as a permanent block.
 */
inviteSchema.index(
  { workspaceId: 1, email: 1 },
  { unique: true, partialFilterExpression: { acceptedAt: null } }
);

export const WorkspaceInvite = mongoose.model("WorkspaceInvite", inviteSchema);
