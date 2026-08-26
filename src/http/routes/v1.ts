import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Project } from "../../modules/workspace/models/Project.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { Event } from "../../modules/analytics/models/Event.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { Marker, MARKER_KINDS } from "../../modules/analytics/models/Marker.js";
import { requireApiKey, ApiKeyRequest } from "../middleware/api-key.js";
import { computeStats, parseFilters } from "../../modules/analytics/stats.service.js";
import { invalidateSite } from "../../modules/billing/event-quota.js";

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
  const filters = parseFilters(req.query.filter);
  const stats = await computeStats([siteId], String(req.query.range ?? "24h"), filters);
  res.json(stats);
});

router.get("/sites/:siteId/snippet", async (req: ApiKeyRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.workspaceId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });
  res.json({ snippet: snippetFor(siteId) });
});

// ---- Timeline markers ----

/**
 * Record a deploy, release, or campaign against the workspace's charts.
 *
 * This is the endpoint the feature exists for: a CI job posting here on every
 * deploy means the markers appear without anyone remembering to add them, and
 * a traffic change a week later has its cause already on the page.
 *
 *   curl -X POST $BASE/v1/markers -H "X-API-Key: …" \
 *        -d '{"label":"v2.4.0","kind":"deploy","description":"'"$GIT_SHA"'"}'
 */
router.post("/markers", async (req: ApiKeyRequest, res: Response) => {
  const label = String(req.body?.label ?? "").trim();
  if (!label) return res.status(400).json({ error: "label required" });
  if (label.length > 80) return res.status(400).json({ error: "label too long" });

  const kind = MARKER_KINDS.includes(req.body?.kind) ? req.body.kind : "deploy";

  // Defaults to now — a deploy hook fires at deploy time. An explicit `at` is
  // for backfilling, and must not silently become "now" if it's malformed.
  const at = req.body?.at ? new Date(String(req.body.at)) : new Date();
  if (Number.isNaN(at.getTime()))
    return res.status(400).json({ error: "at must be a valid date" });

  // Narrowed to sites in this workspace: a key must not be able to annotate
  // charts it cannot read.
  let siteIds: string[] = [];
  if (Array.isArray(req.body?.siteIds) && req.body.siteIds.length) {
    const owned = await Site.find({ workspaceId: req.workspaceId }).select("siteId");
    const ownedSet = new Set(owned.map((s) => String(s.get("siteId"))));
    siteIds = req.body.siteIds.map((id: unknown) => String(id)).filter((id: string) => ownedSet.has(id));
  }

  // An API key authenticates a workspace, not a person, so the owner has to be
  // looked up — `Marker.userId` is required, and the workspace's owner is the
  // only person the marker can honestly be attributed to.
  const workspace = await Workspace.findById(req.workspaceId).select("userId");
  if (!workspace) return res.status(404).json({ error: "workspace not found" });

  const marker = await Marker.create({
    workspaceId: req.workspaceId,
    userId: workspace.get("userId"),
    label,
    description: String(req.body?.description ?? "").slice(0, 500),
    kind,
    at,
    siteIds,
  });

  res.status(201).json({
    id: marker.id,
    label: marker.get("label"),
    kind: marker.get("kind"),
    at: marker.get("at"),
  });
});

router.get("/markers", async (req: ApiKeyRequest, res: Response) => {
  const markers = await Marker.find({ workspaceId: req.workspaceId })
    .sort({ at: -1 })
    .limit(100);

  res.json(
    markers.map((m) => ({
      id: m.id,
      label: m.get("label"),
      description: m.get("description"),
      kind: m.get("kind"),
      at: m.get("at"),
      siteIds: m.get("siteIds"),
    })),
  );
});

router.delete("/sites/:siteId", async (req: ApiKeyRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.workspaceId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });
  await Event.deleteMany({ siteId });
  await site.deleteOne();
  // Drop the cached ingest decision, or this site keeps collecting for up to a
  // minute after the API said it was gone.
  invalidateSite(siteId);
  res.status(204).end();
});

// ---- User journey tracing (identified web apps and mobile apps) ----
//
// Unlike /api/collect (the anonymous landing-page tracker), this is the
// identified-user product: a real web app or mobile app authenticates with
// the workspace's own API key and posts one call per meaningful action —
// "this user went from src to dest via action". No identify()/track() split
// and no client-held SDK state; the user id is just the caller's own id,
// passed on every call, matching how a server-side integration or a mobile
// app with no persistent "current user" object would naturally call it.
const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.slice(0, max) : "";

router.post("/track/:appUserId", async (req: ApiKeyRequest, res: Response) => {
  const appUserId = String(req.params.appUserId ?? "").trim();
  if (!appUserId) return res.status(400).json({ error: "appUserId required" });

  const { siteId, action, src, dest } = req.body ?? {};
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!action) return res.status(400).json({ error: "action required" });

  const site = await ownedSite(req.workspaceId!, String(siteId));
  if (!site) return res.status(404).json({ error: "site not found" });

  await Event.create({
    siteId: String(siteId),
    type: "custom",
    name: str(action, 80),
    appUserId: str(appUserId, 120),
    source: str(src, 120),
    destination: str(dest, 120),
    // path mirrors dest so this event still shows up in the ordinary
    // per-path breakdowns, not only in the journey timeline.
    path: str(dest, 300) || str(src, 300) || "/",
    sessionId: appUserId,
    ts: new Date(),
  });

  res.status(201).json({ ok: true });
});

/**
 * Every appUserId that has traced at least one action for this workspace,
 * most recently active first — the list a dashboard opens before drilling
 * into one user's timeline.
 */
router.get("/users", async (req: ApiKeyRequest, res: Response) => {
  const sites = await Site.find({ workspaceId: req.workspaceId }).select("siteId");
  const ids = sites.map((s) => String(s.get("siteId")));
  if (!ids.length) return res.json({ users: [] });

  const search = String(req.query.q ?? "").trim().slice(0, 120);

  const users = await Event.aggregate([
    {
      $match: {
        siteId: { $in: ids },
        appUserId: search
          ? { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" }
          : { $ne: "" },
      },
    },
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: "$appUserId",
        lastSeen: { $first: "$ts" },
        lastAction: { $first: "$name" },
        siteId: { $first: "$siteId" },
        eventCount: { $sum: 1 },
      },
    },
    { $sort: { lastSeen: -1 } },
    { $limit: 100 },
  ]);

  res.json({
    users: users.map((u) => ({
      appUserId: u._id,
      lastSeen: u.lastSeen,
      lastAction: u.lastAction,
      siteId: u.siteId,
      eventCount: u.eventCount,
    })),
  });
});

/**
 * One user's full journey, oldest first: every src -> action -> dest step in
 * the order it happened.
 */
router.get("/track/:appUserId", async (req: ApiKeyRequest, res: Response) => {
  const appUserId = String(req.params.appUserId ?? "").trim();
  if (!appUserId) return res.status(400).json({ error: "appUserId required" });

  const sites = await Site.find({ workspaceId: req.workspaceId }).select("siteId");
  const ids = sites.map((s) => String(s.get("siteId")));
  if (!ids.length) return res.json({ appUserId, events: [] });

  const limit = Math.min(Number(req.query.limit) || 500, 1000);

  const events = await Event.find({ siteId: { $in: ids }, appUserId })
    .sort({ ts: 1 })
    .limit(limit)
    .select("siteId name source destination ts");

  res.json({
    appUserId,
    events: events.map((e) => ({
      siteId: e.get("siteId"),
      action: e.get("name"),
      src: e.get("source"),
      dest: e.get("destination"),
      ts: e.get("ts"),
    })),
  });
});

export default router;
