import { Router, Response } from "express";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { ApiKey } from "../models/ApiKey.js";
import { requireAuth, requireAdmin, signImpersonationToken, AuthedRequest } from "../auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const PAGE_SIZE = 20;

/**
 * Every account, for the admin's user switcher.
 *
 * `q` matches email or name, `role` narrows to admins or plain users, and the
 * result is paged. The match is a case-insensitive regex rather than a text
 * index — the list is small, and a partial "goswa" needs to hit mid-word.
 */
router.get("/users", async (req: AuthedRequest, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  const role = String(req.query.role ?? "").trim();
  const page = Math.max(1, Number(req.query.page) || 1);

  const filter: Record<string, unknown> = {};
  if (q) {
    filter.$or = [
      { email: { $regex: escapeRegex(q), $options: "i" } },
      { name: { $regex: escapeRegex(q), $options: "i" } },
    ];
  }
  if (role === "admin" || role === "user") filter.role = role;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("email name role createdAt")
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE),
    User.countDocuments(filter),
  ]);

  // One grouped count for the whole page beats a query per user.
  const ids = users.map((u) => u._id);
  const counts = await Workspace.aggregate<{ _id: unknown; n: number }>([
    { $match: { userId: { $in: ids } } },
    { $group: { _id: "$userId", n: { $sum: 1 } } },
  ]);
  const byUser = new Map(counts.map((c) => [String(c._id), c.n]));

  res.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.get("createdAt"),
      workspaceCount: byUser.get(u.id) ?? 0,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

/**
 * Mint a token that acts as the target user.
 *
 * The token carries the admin's id as `impersonatorId`, so the act stays
 * attributable, and every existing route keeps its normal `userId` guard —
 * nothing is relaxed for admins, which is what keeps one bad id parameter from
 * turning into a cross-tenant leak.
 */
router.post("/impersonate/:userId", async (req: AuthedRequest, res: Response) => {
  const target = await User.findById(req.params.userId).select("email name role");
  if (!target) return res.status(404).json({ error: "user not found" });

  // Admins impersonating admins is an escalation path with no legitimate use.
  if (target.role === "admin")
    return res.status(400).json({ error: "cannot impersonate an admin" });

  const token = signImpersonationToken(target.id, req.userId as string);

  console.log(`[impersonate] admin ${req.userId} -> user ${target.id} (${target.email})`);

  res.json({
    token,
    user: { id: target.id, email: target.email, name: target.name, role: target.role },
  });
});

/**
 * Delete an account and everything it owns.
 *
 * The cascade mirrors workspace deletion, one tenant at a time: a user's
 * workspaces take their sites, and each site takes its events. Api keys hang
 * off the user directly, so they go in one sweep. The user row is last, so a
 * mid-cascade failure leaves the account still present and retryable rather
 * than an orphaned pile of data pointing at nothing.
 */
router.delete("/users/:userId", async (req: AuthedRequest, res: Response) => {
  const target = await User.findById(req.params.userId).select("email role");
  if (!target) return res.status(404).json({ error: "user not found" });

  // Deleting an admin — or yourself — is an own-goal with no undo, so block
  // both at the door. The role guard also stops one admin from wiping another.
  if (target.role === "admin")
    return res.status(400).json({ error: "cannot delete an admin account" });
  if (target.id === req.userId)
    return res.status(400).json({ error: "cannot delete your own account" });

  const workspaces = await Workspace.find({ userId: target.id }).select("_id");
  const wsIds = workspaces.map((w) => w._id);

  const sites = await Site.find({ workspaceId: { $in: wsIds } }).select("siteId");
  const siteIds = sites.map((s) => s.siteId);

  await Event.deleteMany({ siteId: { $in: siteIds } });
  await Site.deleteMany({ workspaceId: { $in: wsIds } });
  await ApiKey.deleteMany({ userId: target.id });
  await Workspace.deleteMany({ userId: target.id });
  await target.deleteOne();

  console.log(`[admin] ${req.userId} deleted user ${target.id} (${target.email})`);

  res.json({ ok: true });
});

/** Characters that would otherwise be read as regex syntax in a search box. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
