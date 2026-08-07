import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Membership, ROLE_RANK, WORKSPACE_ROLES, type WorkspaceRole } from "../models/Membership.js";
import { WorkspaceInvite } from "../models/WorkspaceInvite.js";
import { User } from "../models/User.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";
import { resolveAccess, isDenied } from "../lib/access.js";
import { sendWorkspaceInviteEmail, mailConfigured } from "../lib/mail.js";

/**
 * Workspace membership: who is in a workspace, and who may change that.
 *
 * Mounted under `/api/workspaces/:wid/members`, so every route here resolves
 * the caller's own access through the same helper the rest of the app uses.
 *
 * Managing people is admin-and-up throughout. Reading the list is open to any
 * member, because knowing who else can see your analytics is not privileged
 * information to the people already in the room.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

/** How long an invitation link stays good. */
const INVITE_DAYS = 14;

/** Roles that can be handed out. `owner` is not among them — see the model. */
const GRANTABLE = WORKSPACE_ROLES.filter((r) => r !== "owner");

function parseRole(raw: unknown): WorkspaceRole | null {
  const role = String(raw ?? "");
  return (GRANTABLE as readonly string[]).includes(role) ? (role as WorkspaceRole) : null;
}

/* --------------------------------- members --------------------------------- */

/** Everyone with access to this workspace, plus any invitations still pending. */
router.get("/", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const memberships = await Membership.find({ workspaceId: access.workspace.id }).sort({
    createdAt: 1,
  });

  const users = await User.find({
    _id: { $in: memberships.map((m) => m.userId) },
  }).select("name email avatarUrl");
  const userById = new Map(users.map((u) => [u.id, u]));

  // Pending invites only. Accepted ones are already represented by a
  // membership above, and showing both would list the same person twice.
  const invites = await WorkspaceInvite.find({
    workspaceId: access.workspace.id,
    acceptedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: 1 });

  res.json({
    /** The caller's own role, so the client knows which controls to offer. */
    role: access.role,
    members: memberships.map((m) => {
      const user = userById.get(String(m.userId));
      return {
        id: m.id,
        userId: String(m.userId),
        name: user?.name ?? "",
        email: user?.email ?? "",
        avatarUrl: user?.avatarUrl ?? "",
        role: m.role,
        joinedAt: m.get("createdAt"),
        /** True for the caller's own row, which the UI must not offer to remove. */
        isSelf: String(m.userId) === String(req.userId),
      };
    }),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      invitedAt: i.get("createdAt"),
      expiresAt: i.expiresAt,
    })),
  });
});

/**
 * Invite someone by email.
 *
 * Addressed to an email rather than a user id so it works for people who have
 * no account yet — they sign up through the link and the invite is claimed on
 * their way in.
 */
router.post("/invites", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).json({ error: "a valid email address is required" });

  const role = parseRole(req.body?.role);
  if (!role)
    return res.status(400).json({ error: `role must be one of ${GRANTABLE.join(", ")}` });

  // An admin must not be able to mint someone equal to themselves and then be
  // removed by them. Only the owner can create another admin.
  if (ROLE_RANK[role] >= ROLE_RANK[access.role] && access.role !== "owner")
    return res.status(403).json({ error: `only the owner can grant ${role} access` });

  // Already in? Say so plainly rather than sending a link that would fail on
  // arrival with a confusing "already a member".
  const existingUser = await User.findOne({ email }).select("_id");
  if (existingUser) {
    const already = await Membership.exists({
      workspaceId: access.workspace.id,
      userId: existingUser._id,
    });
    if (already) return res.status(409).json({ error: "they are already a member" });
  }

  if (!mailConfigured())
    return res.status(503).json({ error: "email is not configured, so invitations cannot be sent" });

  const token = nanoid(40);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);

  // Upsert on the pending invite: re-inviting the same address should refresh
  // the existing invitation (new token, new expiry, possibly a new role) rather
  // than collide with it on the unique index.
  const invite = await WorkspaceInvite.findOneAndUpdate(
    { workspaceId: access.workspace.id, email, acceptedAt: null },
    {
      $set: {
        role,
        token,
        expiresAt,
        invitedBy: req.userId,
        workspaceId: access.workspace.id,
        email,
      },
    },
    { upsert: true, new: true },
  );

  const inviter = await User.findById(req.userId).select("name email");

  try {
    await sendWorkspaceInviteEmail(
      { email },
      {
        workspaceName: access.workspace.get("name") as string,
        inviterName: (inviter?.name as string) || (inviter?.email as string) || "A teammate",
        role,
        token,
        expiresInDays: INVITE_DAYS,
        // A recipient without an account has to sign up first; the link handles
        // both cases, but the mail should say which one applies to them.
        hasAccount: Boolean(existingUser),
      },
    );
  } catch (e) {
    // The row exists but nobody was told about it. Remove it rather than
    // leaving an invisible pending invite that blocks re-inviting the address.
    await invite.deleteOne();
    console.error("invite email failed:", email, (e as Error).message);
    return res.status(502).json({ error: "could not send the invitation email" });
  }

  res.status(201).json({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  });
});

/** Withdraw a pending invitation. */
router.delete("/invites/:id", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const invite = await WorkspaceInvite.findOne({
    _id: req.params.id,
    workspaceId: access.workspace.id,
    acceptedAt: null,
  });
  if (!invite) return res.status(404).json({ error: "invitation not found" });

  await invite.deleteOne();
  res.status(204).end();
});

/**
 * Change a member's role.
 *
 * The owner's row is immutable: demoting the owner would leave a workspace
 * whose plan is billed to someone who can no longer manage it.
 */
router.patch("/:id", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const role = parseRole(req.body?.role);
  if (!role)
    return res.status(400).json({ error: `role must be one of ${GRANTABLE.join(", ")}` });

  const membership = await Membership.findOne({
    _id: req.params.id,
    workspaceId: access.workspace.id,
  });
  if (!membership) return res.status(404).json({ error: "member not found" });

  if (membership.role === "owner")
    return res.status(403).json({ error: "the owner's role cannot be changed" });

  // Changing your own role is how an admin would demote themselves out of the
  // ability to undo it, and how the last admin could strand a workspace.
  if (String(membership.userId) === String(req.userId))
    return res.status(403).json({ error: "you cannot change your own role" });

  // Same ceiling as inviting: an admin cannot create a peer.
  if (ROLE_RANK[role] >= ROLE_RANK[access.role] && access.role !== "owner")
    return res.status(403).json({ error: `only the owner can grant ${role} access` });

  // Nor can an admin demote another admin — that is the owner's call.
  if (ROLE_RANK[membership.role as WorkspaceRole] >= ROLE_RANK[access.role] && access.role !== "owner")
    return res.status(403).json({ error: "only the owner can change another admin's role" });

  membership.set("role", role);
  await membership.save();
  res.json({ id: membership.id, role: membership.role });
});

/**
 * Remove someone from the workspace, or leave it yourself.
 *
 * Leaving is allowed at any role, which is why this is not admin-only: a viewer
 * must be able to remove their own access without asking permission.
 */
router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const membership = await Membership.findOne({
    _id: req.params.id,
    workspaceId: access.workspace.id,
  });
  if (!membership) return res.status(404).json({ error: "member not found" });

  const isSelf = String(membership.userId) === String(req.userId);

  if (membership.role === "owner")
    return res.status(403).json({
      error: "the owner cannot be removed — delete the workspace instead",
    });

  if (!isSelf) {
    if (ROLE_RANK[access.role] < ROLE_RANK["admin"])
      return res.status(403).json({ error: "only an admin can remove other members" });
    // An admin removing another admin is the same escalation as demoting one.
    if (ROLE_RANK[membership.role as WorkspaceRole] >= ROLE_RANK[access.role] && access.role !== "owner")
      return res.status(403).json({ error: "only the owner can remove another admin" });
  }

  await membership.deleteOne();
  res.status(204).end();
});

export default router;
