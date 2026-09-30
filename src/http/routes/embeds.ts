import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Embed, EMBED_THEMES } from "../../modules/dashboards/models/Embed.js";
import { DASHBOARD_RANGES, type DashboardRange } from "../../modules/dashboards/models/Dashboard.js";
import { isEmbeddable, newEmbedToken } from "../../modules/dashboards/embed.service.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const MAX_EMBEDS = 100;

type EmbedDoc = InstanceType<typeof Embed>;
type Theme = (typeof EMBED_THEMES)[number];

function present(e: EmbedDoc) {
  return {
    id: e.id,
    name: e.get("name"),
    widget: e.get("widget"),
    range: e.get("range"),
    theme: e.get("theme"),
    sites: e.get("sites") ?? [],
    token: e.get("token"),
    enabled: e.get("enabled"),
    views: e.get("views") ?? 0,
    lastViewedAt: e.get("lastViewedAt"),
    createdAt: e.get("createdAt"),
  };
}

async function ownedSites(workspaceId: string, requested: unknown): Promise<string[]> {
  if (!Array.isArray(requested) || requested.length === 0) return [];
  const sites = await Site.find({ workspaceId }).select("siteId");
  const owned = new Set(sites.map((s) => String(s.siteId)));
  return requested.map(String).filter((id) => owned.has(id)).slice(0, 50);
}

function readRange(raw: unknown): DashboardRange | undefined {
  return DASHBOARD_RANGES.includes(raw as DashboardRange) ? (raw as DashboardRange) : undefined;
}

function readTheme(raw: unknown): Theme | undefined {
  return EMBED_THEMES.includes(raw as Theme) ? (raw as Theme) : undefined;
}

async function findEmbed(workspaceId: string, id: string) {
  if (!isValidObjectId(id)) return null;
  return Embed.findOne({ _id: id, workspaceId });
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res);
    if (!ws) return;
    const embeds = await Embed.find({ workspaceId: ws.id }).sort({ createdAt: -1 });
    res.json(embeds.map(present));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    const widget = String(req.body?.widget ?? "");
    if (!isEmbeddable(widget)) return res.status(400).json({ error: "this widget cannot be embedded" });

    if ((await Embed.countDocuments({ workspaceId: ws.id })) >= MAX_EMBEDS) {
      return res.status(409).json({ error: `a workspace can hold up to ${MAX_EMBEDS} embeds` });
    }

    const embed = await Embed.create({
      workspaceId: ws.id,
      name: String(req.body?.name ?? widget).trim().slice(0, 80) || widget,
      widget,
      range: readRange(req.body?.range) ?? "30d",
      theme: readTheme(req.body?.theme) ?? "auto",
      sites: await ownedSites(ws.id, req.body?.sites),
      token: newEmbedToken(),
      createdBy: req.userId,
    });
    res.status(201).json(present(embed));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    const embed = await findEmbed(ws.id, String(req.params.id));
    if (!embed) return res.status(404).json({ error: "embed not found" });

    const body = req.body ?? {};
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "name required" });
      embed.set("name", name);
    }
    if (body.range !== undefined) {
      const range = readRange(body.range);
      if (!range) return res.status(400).json({ error: "range must be 24h, 7d or 30d" });
      embed.set("range", range);
    }
    if (body.theme !== undefined) {
      const theme = readTheme(body.theme);
      if (!theme) return res.status(400).json({ error: "theme must be auto, light or dark" });
      embed.set("theme", theme);
    }
    if (body.sites !== undefined) embed.set("sites", await ownedSites(ws.id, body.sites));
    if (body.enabled !== undefined) embed.set("enabled", Boolean(body.enabled));

    await embed.save();
    res.json(present(embed));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    const embed = await findEmbed(ws.id, String(req.params.id));
    if (!embed) return res.status(404).json({ error: "embed not found" });
    await embed.deleteOne();
    res.status(204).end();
  }),
);

export default router;
