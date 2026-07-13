import { Router, Response } from "express";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
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

/** Characters that would otherwise be read as regex syntax in a search box. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default router;
