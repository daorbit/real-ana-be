import { Router, Response, Request } from "express";
import { WorkspaceInvite } from "../models/WorkspaceInvite.js";
import { Membership } from "../models/Membership.js";
import { Workspace } from "../models/Workspace.js";
import { User } from "../models/User.js";
import { requireAuth, AuthedRequest } from "../auth.js";

/**
 * Accepting a workspace invitation. Mounted at `/api/invites`.
 *
 * Split from the members router because these are reached by the *recipient*,
 * who by definition has no access to the workspace yet — every route there
 * starts by resolving access the recipient does not have.
 */
const router = Router();

/**
 * What an invitation is for, readable without signing in.
 *
 * The landing page needs to say "Ana invited you to Acme Inc." before asking
 * anyone to log in or sign up — an invite link that leads to a bare login form
 * gives no reason to complete it.
 *
 * Deliberately thin: the workspace's name and the inviter's, nothing about its
 * data. The token is a bearer credential that may have been forwarded or
 * leaked, so what it reveals before authentication is kept to what the email
 * already said.
 */
router.get("/:token", async (req: Request, res: Response) => {
  const invite = await WorkspaceInvite.findOne({ token: String(req.params.token) });
  if (!invite) return res.status(404).json({ error: "this invitation link is not valid" });

  if (invite.acceptedAt)
    return res.status(409).json({ error: "this invitation has already been accepted" });
  if (invite.expiresAt.getTime() < Date.now())
    return res.status(410).json({ error: "this invitation has expired — ask for a new one" });

  const workspace = await Workspace.findById(invite.workspaceId).select("name");
  if (!workspace)
    return res.status(404).json({ error: "that workspace no longer exists" });

  const inviter = await User.findById(invite.invitedBy).select("name email");
  // Whether the address already has an account, so the page can offer "log in"
  // rather than "sign up" — getting this backwards is the fastest way to make
  // someone abandon an invitation.
  const existing = await User.exists({ email: invite.email });

  res.json({
    workspaceName: workspace.name,
    inviterName: (inviter?.name as string) || (inviter?.email as string) || "A teammate",
    email: invite.email,
    role: invite.role,
    hasAccount: Boolean(existing),
  });
});

/**
 * Claim an invitation as the signed-in user.
 *
 * The invited address and the accepting account do not have to match. Someone
 * invited at a work address may well sign in with the Google account they
 * actually use, and refusing that turns a working link into a support ticket.
 * The token is the credential; holding it is what grants the access, exactly
 * as with the share links elsewhere in the app.
 */
router.post("/:token/accept", requireAuth, async (req: AuthedRequest, res: Response) => {
  const invite = await WorkspaceInvite.findOne({ token: String(req.params.token) });
  if (!invite) return res.status(404).json({ error: "this invitation link is not valid" });

  if (invite.acceptedAt)
    return res.status(409).json({ error: "this invitation has already been accepted" });
  if (invite.expiresAt.getTime() < Date.now())
    return res.status(410).json({ error: "this invitation has expired — ask for a new one" });

  const workspace = await Workspace.findById(invite.workspaceId).select("_id name");
  if (!workspace) return res.status(404).json({ error: "that workspace no longer exists" });

  // Already a member — most likely they followed the link twice. Treat it as
  // success and send them on rather than showing an error for a state that is
  // exactly what they wanted.
  const existing = await Membership.findOne({
    workspaceId: workspace.id,
    userId: req.userId,
  });

  if (!existing) {
    await Membership.create({
      workspaceId: workspace.id,
      userId: req.userId,
      role: invite.role,
      invitedBy: invite.invitedBy,
    });
  }

  // Marked accepted either way: the link has been used, and leaving it live
  // would let a forwarded copy add someone else too.
  invite.set("acceptedAt", new Date());
  invite.set("acceptedBy", req.userId);
  await invite.save();

  res.json({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    role: existing ? existing.role : invite.role,
  });
});

export default router;
