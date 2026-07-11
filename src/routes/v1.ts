import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Project } from "../models/Project.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { requireApiKey, ApiKeyRequest } from "../apikey.js";
import { computeStats } from "../stats-core.js";

const router = Router();
router.use(requireApiKey);

const BASE = process.env.PUBLIC_BASE_URL ?? "http://localhost:4000";
const snippetFor = (siteId: string) =>
  `<script async src="${BASE}/tracker.js" data-site="${siteId}"></script>`;

// ---- Projects ----
router.post("/projects", async (req: ApiKeyRequest, res: Response) => {
  const { name, extUserId } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const project = await Project.create({ workspaceId: req.workspaceId, name, extUserId });
  res.status(201).json(project);
});

router.get("/projects", async (req: ApiKeyRequest, res: Response) => {
  const filter: Record<string, unknown> = { workspaceId: req.workspaceId };
  if (req.query.extUserId) filter.extUserId = String(req.query.extUserId);
  const list = await Project.find(filter).sort({ createdAt: -1 });
  res.json(list);
});

// ---- Sites under a project ----
router.post("/projects/:pid/sites", async (req: ApiKeyRequest, res: Response) => {
  const project = await Project.findOne({ _id: req.params.pid, workspaceId: req.workspaceId });
  if (!project) return res.status(404).json({ error: "project not found" });
  const { name, domain, framework } = req.body ?? {};
  if (!name || !domain) return res.status(400).json({ error: "name, domain required" });
  const site = await Site.create({
    workspaceId: req.workspaceId,
    projectId: project.id,
    name,
    domain,
    framework: framework ?? "other",
    siteId: nanoid(16),
  });
  res.status(201).json({ site, snippet: snippetFor(site.siteId as string) });
});

router.get("/projects/:pid/sites", async (req: ApiKeyRequest, res: Response) => {
  const project = await Project.findOne({ _id: req.params.pid, workspaceId: req.workspaceId });
  if (!project) return res.status(404).json({ error: "project not found" });
  const sites = await Site.find({ projectId: project.id }).sort({ createdAt: -1 });
  res.json(sites);
});

// ---- Site stats / snippet / delete (scoped to workspace) ----
async function ownedSite(workspaceId: string, siteId: string) {
  return Site.findOne({ siteId, workspaceId });
}

router.get("/sites/:siteId/stats", async (req: ApiKeyRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.workspaceId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });
  const stats = await computeStats([siteId], String(req.query.range ?? "24h"));
  res.json(stats);
});

router.get("/sites/:siteId/snippet", async (req: ApiKeyRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.workspaceId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });
  res.json({ snippet: snippetFor(siteId) });
});

router.delete("/sites/:siteId", async (req: ApiKeyRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.workspaceId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });
  await Event.deleteMany({ siteId });
  await site.deleteOne();
  res.status(204).end();
});

export default router;
