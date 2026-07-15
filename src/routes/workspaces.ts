import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import {
  computeStats, computeFunnel, computeRetention, parseFilters, TRACKER_VERSION,
  type FunnelStep,
} from "../stats-core.js";
import { ApiKey } from "../models/ApiKey.js";
import { generateKey } from "../apikey.js";

const router = Router();
router.use(requireAuth);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Create workspace
router.post("/", async (req: AuthedRequest, res: Response) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const ws = await Workspace.create({
    userId: req.userId,
    name,
    slug: slugify(name) || nanoid(6),
  });
  res.status(201).json(ws);
});

// List my workspaces
router.get("/", async (req: AuthedRequest, res: Response) => {
  const list = await Workspace.find({ userId: req.userId }).sort({ createdAt: -1 });
  res.json(list);
});

// Create site under workspace
router.post("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const { name, domain, framework } = req.body ?? {};
  if (!name || !domain)
    return res.status(400).json({ error: "name, domain required" });
  const site = await Site.create({
    workspaceId: ws.id,
    userId: req.userId,
    name,
    domain,
    framework: framework ?? "other",
    siteId: nanoid(16),
  });
  res.status(201).json(site);
});

// List sites in workspace
router.get("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).sort({ createdAt: -1 });
  res.json(sites);
});

// Install status for a site — has the tracking script ever reported?
router.get("/:wid/sites/:siteId/status", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const site = await Site.findOne({ siteId: req.params.siteId, workspaceId: ws.id });
  if (!site) return res.status(404).json({ error: "site not found" });

  const siteId = site.siteId as string;
  const [eventCount, last] = await Promise.all([
    Event.countDocuments({ siteId }),
    Event.findOne({ siteId }).sort({ ts: -1 }).select("ts"),
  ]);

  res.json({
    siteId,
    installed: eventCount > 0,
    eventCount,
    lastEventAt: last?.ts ?? null,
  });
});

// Aggregate analytics across all sites in a workspace
router.get("/:wid/stats", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId name trackerVersion");
  const ids = sites.map((s) => s.siteId as string);
  if (ids.length === 0) {
    return res.json({
      range: String(req.query.range ?? "24h"),
      pageviews: 0, visitors: 0, live: 0,
      topPages: [], topReferrers: [], devices: [], countries: [], utmSources: [],
      timeseries: [], siteCount: 0, outdatedSites: [],
    });
  }

  // Sites still on a script that predates impressions and scroll depth. Those
  // panels can only ever be empty for them, so the dashboard says so rather
  // than letting it read as "no engagement".
  const outdatedSites = sites
    .filter((s) => (s.trackerVersion ?? 1) < TRACKER_VERSION)
    .map((s) => ({ siteId: s.siteId as string, name: s.name as string }));

  const filters = parseFilters(req.query.filter);
  const stats = await computeStats(ids, String(req.query.range ?? "24h"), filters);
  res.json({ ...stats, siteCount: ids.length, outdatedSites, filters });
});

// Ad-hoc conversion funnel: the client sends an ordered list of steps (pages or
// custom events) and gets per-step drop-off back. Kept as POST because the step
// list is structured and unbounded, not a tidy query string.
router.post("/:wid/funnel", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const raw = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const steps: FunnelStep[] = raw
    .map((s: { type?: string; value?: string }) => ({
      type: s?.type === "event" ? "event" : "page",
      value: String(s?.value ?? "").slice(0, 300),
    }))
    .filter((s: FunnelStep) => s.value)
    .slice(0, 8);

  if (steps.length < 2) {
    return res.status(400).json({ error: "at least 2 steps required" });
  }

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  if (ids.length === 0) return res.json({ steps: [] });

  const result = await computeFunnel(ids, steps, String(req.body?.range ?? "24h"));
  res.json({ steps: result });
});

// Weekly retention cohorts for the workspace.
router.get("/:wid/retention", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  if (ids.length === 0) return res.json({ weeks: 6, cohorts: [] });

  const weeks = Math.min(12, Math.max(2, Number(req.query.weeks) || 6));
  const cohorts = await computeRetention(ids, weeks);
  res.json({ weeks, cohorts });
});

// Rename workspace
router.patch("/:wid", async (req: AuthedRequest, res: Response) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const ws = await Workspace.findOneAndUpdate(
    { _id: req.params.wid, userId: req.userId },
    { name, slug: slugify(name) || nanoid(6) },
    { new: true }
  );
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  res.json(ws);
});

// Delete workspace + its sites + their events
router.delete("/:wid", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  await Event.deleteMany({ siteId: { $in: ids } });
  await Site.deleteMany({ workspaceId: ws.id });
  await ws.deleteOne();
  res.status(204).end();
});

// Delete a single site + its events
router.delete("/:wid/sites/:siteId", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const site = await Site.findOne({ siteId: req.params.siteId, workspaceId: ws.id });
  if (!site) return res.status(404).json({ error: "site not found" });
  await Event.deleteMany({ siteId: site.siteId });
  await site.deleteOne();
  res.status(204).end();
});

// ---- Home layout ----
// Which widgets the home grid shows, in what order, and how wide each is.
// Stored per workspace so each dashboard keeps its own arrangement.

type Placed = { id: string; span: number };

/**
 * Widget ids are defined in the frontend, so validating them here would mean a
 * second list that silently drifts. Check only the shape — the client already
 * drops ids it doesn't recognise when it reads the layout back.
 */
function parseLayout(body: unknown): Placed[] | null {
  if (!Array.isArray(body) || body.length > 50) return null;
  const out: Placed[] = [];
  for (const item of body) {
    const id = (item as Placed)?.id;
    const span = (item as Placed)?.span;
    if (typeof id !== "string" || !id || id.length > 64) return null;
    if (![1, 2, 3, 4].includes(span)) return null;
    out.push({ id, span });
  }
  return out;
}

router.get("/:wid/layout", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  // null, not [], so the client can tell "never customised" from "emptied".
  res.json({ layout: ws.homeLayout ?? null });
});

router.put("/:wid/layout", async (req: AuthedRequest, res: Response) => {
  const layout = parseLayout(req.body);
  if (!layout)
    return res.status(400).json({ error: "layout must be an array of { id, span: 1|2|3|4 }" });
  const ws = await Workspace.findOneAndUpdate(
    { _id: req.params.wid, userId: req.userId },
    { homeLayout: layout },
    { new: true }
  );
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  res.json({ layout: ws.homeLayout ?? [] });
});

// ---- API keys (platform integration) ----
// Create a key — returns the raw secret ONCE.
router.post("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const { name } = req.body ?? {};
  const { raw, keyHash, prefix } = generateKey();
  const key = await ApiKey.create({
    workspaceId: ws.id,
    userId: req.userId,
    name: name || "Default key",
    keyHash,
    prefix,
  });
  res.status(201).json({ id: key.id, name: key.name, prefix: key.prefix, key: raw, createdAt: key.createdAt });
});

// List keys (masked — never returns the raw secret again)
router.get("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const keys = await ApiKey.find({ workspaceId: ws.id, revoked: false }).sort({ createdAt: -1 });
  res.json(keys.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt, createdAt: k.get("createdAt"),
  })));
});

// Revoke a key
router.delete("/:wid/keys/:kid", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const key = await ApiKey.findOne({ _id: req.params.kid, workspaceId: ws.id });
  if (!key) return res.status(404).json({ error: "key not found" });
  key.set("revoked", true);
  await key.save();
  res.status(204).end();
});

export default router;
