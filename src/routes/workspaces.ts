import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { requireAuth, AuthedRequest } from "../auth.js";

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

export default router;
