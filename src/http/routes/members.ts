import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Membership, ROLE_RANK, WORKSPACE_ROLES, type WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { WorkspaceInvite } from "../../modules/workspace/models/WorkspaceInvite.js";
import { User } from "../../modules/identity/models/User.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveAccess, isDenied } from "../../modules/workspace/access.service.js";
import { sendWorkspaceInviteEmail, mailConfigured } from "../../infra/mail/mailer.js";
import { emitTo } from "../../modules/notifications/notify.service.js";
import { recordAudit } from "../../modules/audit/audit.service.js";

async function memberLabel(userId: unknown): Promise<string> {
  const user = await User.findById(userId).select("name email").lean();
  return (user?.name as string) || (user?.email as string) || "";
}


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

  const inviter = await User.findById(req.userId).select("name email avatarUrl");

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

  // Someone who already has an account gets the invitation in their bell as
  // well as their inbox — the dashboard is where they will act on it, and an
  // invite that exists only in email is one more thing to go looking for.
  //
  // An address with no account gets the email alone: there is no user to
  // address a row to yet. The invitation is claimed on their first sign-in, at
  // which point the workspace is simply there.
  if (existingUser) {
    await notifyInviteReceived(String(existingUser._id), {
      workspaceName: access.workspace.get("name") as string,
      inviterName: (inviter?.name as string) || (inviter?.email as string) || "A teammate",
      inviterAvatarUrl: (inviter?.avatarUrl as string) || "",
      role,
      token,
    }, String(req.userId));
  }

  await recordAudit(req, {
    action: "member.invited",
    workspaceId: access.workspace.id,
    target: { kind: "invite", id: invite.id, label: email },
    meta: { role },
  });

  res.status(201).json({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  });
});

/**
 * The invitation notification, kept as a named helper purely to keep the route
 * above readable — it already carries the email send, its failure path and the
 * upsert.
 */
async function notifyInviteReceived(
  userId: string,
  data: {
    workspaceName: string;
    inviterName: string;
    inviterAvatarUrl?: string;
    role: string;
    token: string;
  },
  actorId: string,
): Promise<void> {
  await emitTo({
    type: "invite.received",
    userId,
    actorId,
    data: {
      workspaceName: data.workspaceName,
      inviterName: data.inviterName,
      actorAvatarUrl: data.inviterAvatarUrl || "",
      role: data.role,
    },
    link: `/invite/${data.token}`,
  });
}

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

  await Promise.all([
    invite.deleteOne(),
    recordAudit(req, {
      action: "member.invite_withdrawn",
      workspaceId: access.workspace.id,
      target: { kind: "invite", id: invite.id, label: invite.email },
      meta: { role: invite.role },
    }),
  ]);
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

  const previousRole = membership.role;
  membership.set("role", role);
  const [, label] = await Promise.all([membership.save(), memberLabel(membership.userId)]);
  await recordAudit(req, {
    action: "member.role_changed",
    workspaceId: access.workspace.id,
    target: { kind: "member", id: String(membership.userId), label },
    meta: { from: previousRole, to: role },
  });
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

  const [, label] = await Promise.all([membership.deleteOne(), memberLabel(membership.userId)]);
  await recordAudit(req, {
    action: isSelf ? "member.left" : "member.removed",
    workspaceId: access.workspace.id,
    target: { kind: "member", id: String(membership.userId), label },
    meta: { role: membership.role },
  });
  res.status(204).end();
});

export default router;
