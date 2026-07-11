import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import { computeStats } from "../stats-core.js";

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

// Aggregate analytics across all sites in a workspace
router.get("/:wid/stats", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  if (ids.length === 0) {
    return res.json({
      range: String(req.query.range ?? "24h"),
      pageviews: 0, visitors: 0, live: 0,
      topPages: [], topReferrers: [], devices: [], countries: [], utmSources: [],
      timeseries: [], siteCount: 0,
    });
  }
  const stats = await computeStats(ids, String(req.query.range ?? "24h"));
  res.json({ ...stats, siteCount: ids.length });
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

export default router;
