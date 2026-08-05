import { Router, Response } from "express";
import { Marker, MARKER_KINDS } from "../models/Marker.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";

/**
 * Timeline markers — deploys, campaigns, incidents — drawn over the charts.
 *
 * Mounted under `/api/workspaces/:wid/markers`, same ownership rule as every
 * other workspace-scoped route.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

/** The caller's workspace, or null — never "someone else's workspace". */
async function ownedWorkspace(req: AuthedRequest) {
  return Workspace.findOne({ _id: req.params.wid, userId: req.userId });
}

function present(marker: InstanceType<typeof Marker>) {
  return {
    id: marker.id,
    label: marker.get("label"),
    description: marker.get("description"),
    kind: marker.get("kind"),
    at: marker.get("at"),
    siteIds: marker.get("siteIds"),
  };
}

/**
 * Site ids a marker may name, narrowed to ones in this workspace.
 *
 * An id from elsewhere isn't rejected outright — it's dropped. A CI job
 * posting a stale site id should still record the deploy against the sites it
 * does own, rather than failing the whole call and losing the marker.
 */
async function ownedSiteIds(workspaceId: string, requested: unknown): Promise<string[]> {
  if (!Array.isArray(requested) || !requested.length) return [];

  const sites = await Site.find({ workspaceId }).select("siteId");
  const owned = new Set(sites.map((s) => String(s.get("siteId"))));

  return requested.map((id) => String(id)).filter((id) => owned.has(id));
}

/**
 * Markers in a time window, newest first.
 *
 * `from`/`to` are ISO timestamps matching the dashboard's current range —
 * markers outside the visible window would be fetched and thrown away.
 */
router.get("/", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const filter: Record<string, unknown> = { workspaceId: ws.id };

  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  const window: Record<string, Date> = {};
  if (from && !Number.isNaN(from.getTime())) window.$gte = from;
  if (to && !Number.isNaN(to.getTime())) window.$lte = to;
  if (Object.keys(window).length) filter.at = window;

  const markers = await Marker.find(filter).sort({ at: -1 }).limit(200);
  res.json(markers.map(present));
});

router.post("/", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const label = String(req.body?.label ?? "").trim();
  if (!label) return res.status(400).json({ error: "label is required" });
  if (label.length > 80) return res.status(400).json({ error: "label is too long" });

  const kind = MARKER_KINDS.includes(req.body?.kind) ? req.body.kind : "deploy";

  // Defaults to now, which is what a CI hook posting on deploy wants. An
  // explicit timestamp is for backfilling something that already happened.
  const at = req.body?.at ? new Date(String(req.body.at)) : new Date();
  if (Number.isNaN(at.getTime()))
    return res.status(400).json({ error: "at must be a valid date" });

  const marker = await Marker.create({
    workspaceId: ws.id,
    userId: req.userId,
    label,
    description: String(req.body?.description ?? "").slice(0, 500),
    kind,
    at,
    siteIds: await ownedSiteIds(ws.id, req.body?.siteIds),
  });

  res.status(201).json(present(marker));
});

router.patch("/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const update: Record<string, unknown> = {};

  if (req.body?.label !== undefined) {
    const label = String(req.body.label).trim();
    if (!label) return res.status(400).json({ error: "label cannot be empty" });
    if (label.length > 80) return res.status(400).json({ error: "label is too long" });
    update.label = label;
  }

  if (req.body?.description !== undefined)
    update.description = String(req.body.description).slice(0, 500);

  if (req.body?.kind !== undefined) {
    if (!MARKER_KINDS.includes(req.body.kind))
      return res.status(400).json({ error: "unknown marker kind" });
    update.kind = req.body.kind;
  }

  if (req.body?.at !== undefined) {
    const at = new Date(String(req.body.at));
    if (Number.isNaN(at.getTime()))
      return res.status(400).json({ error: "at must be a valid date" });
    update.at = at;
  }

  if (req.body?.siteIds !== undefined)
    update.siteIds = await ownedSiteIds(ws.id, req.body.siteIds);

  if (!Object.keys(update).length)
    return res.status(400).json({ error: "nothing to update" });

  const marker = await Marker.findOneAndUpdate(
    { _id: req.params.id, workspaceId: ws.id },
    { $set: update },
    { new: true },
  );
  if (!marker) return res.status(404).json({ error: "marker not found" });

  res.json(present(marker));
});

router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const result = await Marker.deleteOne({ _id: req.params.id, workspaceId: ws.id });
  if (!result.deletedCount) return res.status(404).json({ error: "marker not found" });

  res.json({ ok: true });
});

export default router;
