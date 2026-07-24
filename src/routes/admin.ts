import { Router, Response } from "express";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { ApiKey } from "../models/ApiKey.js";
import { Goal } from "../models/Goal.js";
import { Project } from "../models/Project.js";
import { getDemoDailyLimit, setDemoDailyLimit } from "../models/AppSetting.js";
import { demoUsageSnapshot } from "../lib/demo-limit.js";
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

  // One grouped query per collection for the whole page beats a query per user.
  const ids = users.map((u) => u._id);
  const workspaces = await Workspace.find({ userId: { $in: ids } }).select("userId");
  const ownerByWorkspace = new Map(
    workspaces.map((w) => [String(w._id), String(w.userId)]),
  );

  const wsByUser = new Map<string, number>();
  for (const owner of ownerByWorkspace.values())
    wsByUser.set(owner, (wsByUser.get(owner) ?? 0) + 1);

  // Sites resolve through the workspace, not `Site.userId` — platform-created
  // sites have no dashboard user, so keying off the workspace is what makes
  // their traffic show up under the account that actually owns them.
  const pageSites = await Site.find({
    workspaceId: { $in: [...ownerByWorkspace.keys()] },
  }).select("siteId workspaceId");

  const sitesByUser = new Map<string, number>();
  const ownerBySiteId = new Map<string, string>();
  for (const s of pageSites) {
    const owner = ownerByWorkspace.get(String(s.workspaceId));
    if (!owner) continue;
    ownerBySiteId.set(String(s.siteId), owner);
    sitesByUser.set(owner, (sitesByUser.get(owner) ?? 0) + 1);
  }

  // Events key off `siteId` (the public nanoid), not the owner, so the sites
  // above are the bridge back to a user.
  const eventCounts = await Event.aggregate<{ _id: string; n: number; last: Date }>([
    { $match: { siteId: { $in: [...ownerBySiteId.keys()] } } },
    { $group: { _id: "$siteId", n: { $sum: 1 }, last: { $max: "$ts" } } },
  ]);
  const eventsByUser = new Map<string, { n: number; last: Date | null }>();
  for (const row of eventCounts) {
    const owner = ownerBySiteId.get(row._id);
    if (!owner) continue;
    const acc = eventsByUser.get(owner) ?? { n: 0, last: null };
    acc.n += row.n;
    if (row.last && (!acc.last || row.last > acc.last)) acc.last = row.last;
    eventsByUser.set(owner, acc);
  }

  res.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.get("createdAt"),
      workspaceCount: wsByUser.get(u.id) ?? 0,
      siteCount: sitesByUser.get(u.id) ?? 0,
      eventCount: eventsByUser.get(u.id)?.n ?? 0,
      lastEventAt: eventsByUser.get(u.id)?.last ?? null,
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
  // Keys are scoped to the workspace as well as the user — platform keys
  // created under a workspace would otherwise survive the account.
  await ApiKey.deleteMany({
    $or: [{ userId: target.id }, { workspaceId: { $in: wsIds } }],
  });
  await Goal.deleteMany({ workspaceId: { $in: wsIds } });
  await Project.deleteMany({ workspaceId: { $in: wsIds } });
  await Workspace.deleteMany({ userId: target.id });
  await target.deleteOne();

  console.log(`[admin] ${req.userId} deleted user ${target.id} (${target.email})`);

  res.json({ ok: true });
});

/** Characters that would otherwise be read as regex syntax in a search box. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------- demo usage ------------------------------- */

/**
 * How the public demo is being used.
 *
 * The figures come from the in-process throttle rather than a table: nothing
 * about a demo visitor is stored, so this is a live snapshot — counts reset
 * when the server does, and each instance reports its own. Enough to see
 * whether the demo is being used and whether the limit is biting; deliberately
 * not an audit trail.
 */
router.get("/demo/usage", async (_req: AuthedRequest, res: Response) => {
  const [limit, snapshot] = await Promise.all([
    getDemoDailyLimit(),
    Promise.resolve(demoUsageSnapshot()),
  ]);
  res.json({ limit, ...snapshot });
});

/** Change how many demo sessions one address may start per day. */
router.put("/demo/limit", async (req: AuthedRequest, res: Response) => {
  const requested = Number(req.body?.limit);
  if (!Number.isFinite(requested) || requested < 1) {
    return res.status(400).json({ error: "limit must be a positive number" });
  }
  const limit = await setDemoDailyLimit(requested);
  res.json({ limit });
});

export default router;
