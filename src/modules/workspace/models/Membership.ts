import mongoose, { Schema } from "mongoose";

/**
 * One person's access to one workspace.
 *
 * Replaces `Workspace.userId` as the authority on who may reach a workspace.
 * The creator gets an `owner` row when the workspace is made, so ownership and
 * membership are the same mechanism rather than two things every route has to
 * check separately — "can this user touch this workspace" is one lookup.
 *
 * Roles, weakest first:
 *
 * - `viewer`  — reads everything: analytics, reports, SEO history. Writes
 *               nothing at all, including "harmless" writes like saving a
 *               segment, because a read-only seat that quietly persists state
 *               is not read-only.
 * - `editor`  — everything a viewer does, plus the day-to-day work: adding
 *               sites, goals, segments, markers, report schedules, and running
 *               audits and crawls. Cannot touch members or billing.
 * - `admin`   — everything an editor does, plus inviting and removing people
 *               and changing their roles. Can also buy plans and addons.
 * - `owner`   — the creator. Everything an admin does, plus deleting the
 *               workspace itself, and cannot be removed or demoted. Exactly one
 *               per workspace.
 *
 * Deleting the workspace is owner-only because it destroys other members' work
 * irreversibly, and an admin who can be appointed by another admin should not
 * inherit that.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Role strength, for "is this role at least X" checks. Higher wins.
 *
 * A numeric ladder rather than a set per permission: the roles here are
 * genuinely cumulative — every editor power is an admin power — so a ladder
 * says that once instead of repeating it in four lists that can drift apart.
 */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

const membershipSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: WORKSPACE_ROLES, required: true, default: "viewer" },
    /**
     * Who added them, kept for the members list ("invited by …"). Null on the
     * owner's own row, which nobody granted, and on rows written by the
     * migration that backfilled existing workspaces.
     */
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// One row per person per workspace: a second row would mean two roles at once,
// and which one wins would come down to document order.
membershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const Membership = mongoose.model("Membership", membershipSchema);
