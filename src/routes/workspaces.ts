import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { Event } from "../models/Event.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import {
  computeStats,
  computeFunnel,
  computeRetention,
  computeGoals,
  exportEvents,
  resolveWindow,
  parseFilters,
  EXPORT_COLUMNS,
  TRACKER_VERSION,
  type FunnelStep,
  type GoalDef,
} from "../stats-core.js";
import ExcelJS from "exceljs";
import { ApiKey } from "../models/ApiKey.js";
import { Goal } from "../models/Goal.js";
import { Project } from "../models/Project.js";
import { generateKey } from "../apikey.js";

const router = Router();
router.use(requireAuth);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Normalise the tracker options a client sends.
 *
 * Stored for snippet rebuilding only, but still bounded — these end up in an
 * HTML attribute, and an unbounded list would produce a script tag no one can
 * paste. `clicks`/`errors` default to on, matching the tracker.
 */
function parseTrackerOptions(raw: unknown) {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((s) => s.slice(0, 200));

  return {
    dnt: !!o.dnt,
    hash: !!o.hash,
    clicks: o.clicks === undefined ? true : !!o.clicks,
    errors: o.errors === undefined ? true : !!o.errors,
    ignorePages: list(o.ignorePages),
    allowParams: list(o.allowParams),
    domain: String(o.domain ?? "").trim().slice(0, 253),
  };
}

function selectSiteIds(
  sites: Array<{ siteId?: unknown }>,
  requested: unknown,
): string[] {
  const owned = sites.map((s) => String(s.siteId));

  const raw = Array.isArray(requested)
    ? requested
    : typeof requested === "string" && requested
      ? requested.split(",")
      : [];
  const wanted = new Set(raw.map((s) => String(s).trim()).filter(Boolean));

  if (wanted.size === 0) return owned;
  return owned.filter((id) => wanted.has(id));
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
  const list = await Workspace.find({ userId: req.userId }).sort({
    createdAt: -1,
  });
  res.json(list);
});

// Create site under workspace
router.post("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const { name, domain, framework, trackerOptions } = req.body ?? {};
  if (!name || !domain)
    return res.status(400).json({ error: "name, domain required" });
  const site = await Site.create({
    workspaceId: ws.id,
    userId: req.userId,
    name,
    domain,
    framework: framework ?? "other",
    siteId: nanoid(16),
    trackerOptions: parseTrackerOptions(trackerOptions),
  });
  res.status(201).json(site);
});

// List sites in workspace
router.get("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).sort({ createdAt: -1 });
  res.json(sites);
});

/**
 * Update a site's stored tracker options.
 *
 * Changing these does not change what the site reports — the pasted script tag
 * is what the tracker actually reads. This only updates what the dashboard
 * rebuilds the snippet from, so the user is told to re-copy.
 */
router.patch(
  "/:wid/sites/:siteId/options",
  async (req: AuthedRequest, res: Response) => {
    const ws = await Workspace.findOne({
      _id: req.params.wid,
      userId: req.userId,
    });
    if (!ws) return res.status(404).json({ error: "workspace not found" });
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: ws.id,
    });
    if (!site) return res.status(404).json({ error: "site not found" });

    site.set("trackerOptions", parseTrackerOptions(req.body));
    await site.save();
    res.json(site);
  },
);

/* ---------------------------- public sharing ---------------------------- */

/**
 * The panels a public dashboard can show, and their defaults.
 *
 * The originals default to true — that is what every existing shared link
 * already publishes. Everything added later defaults to false: a workspace
 * that was already sharing must not start exposing new breakdowns because we
 * shipped a release. Turning one on is the owner's decision.
 */
const SHARE_PANEL_DEFAULTS: Record<string, boolean> = {
  totals: true,
  trend: true,
  pages: true,
  sources: true,
  countries: true,
  devices: true,

  browsers: false,
  operatingSystems: false,
  entryPages: false,
  exitPages: false,
  languages: false,
  channels: false,
  engagement: false,
  visitorSplit: false,
};

function readPanels(raw: unknown): Record<string, boolean> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  // Unknown keys are dropped rather than stored — the public route reads this
  // to decide what to publish, so it must only ever contain fields we know.
  for (const [key, fallback] of Object.entries(SHARE_PANEL_DEFAULTS)) {
    out[key] = o[key] === undefined ? fallback : Boolean(o[key]);
  }
  return out;
}

/** Current share state for a workspace. */
router.get("/:wid/share", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  res.json({
    enabled: Boolean(ws.get("shareEnabled")),
    token: ws.get("shareToken") ?? null,
    panels: readPanels(ws.get("sharePanels")),
    views: ws.get("shareViews") ?? 0,
    lastViewedAt: ws.get("shareLastViewedAt") ?? null,
  });
});

/**
 * Turn sharing on or off, optionally minting a fresh token.
 *
 * `rotate` is the only way to invalidate a link that has already been sent
 * somewhere — disabling alone keeps the token so the same URL can be brought
 * back, which is what someone toggling visibility usually wants.
 */
router.put("/:wid/share", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const enabled = Boolean(req.body?.enabled);
  const rotate = Boolean(req.body?.rotate);

  // 32 nanoid chars: the token is the whole credential for an unauthenticated
  // view, so it has to be long enough that guessing is hopeless.
  if (rotate || (enabled && !ws.get("shareToken"))) {
    ws.set("shareToken", `pk_${nanoid(32)}`);
    // A new link is a new audience — carrying the old count over would make
    // the number meaningless.
    if (rotate) {
      ws.set("shareViews", 0);
      ws.set("shareLastViewedAt", null);
    }
  }
  ws.set("shareEnabled", enabled);
  // Only touch panels when the client sends them, so toggling sharing on and
  // off does not silently reset a customised selection.
  if (req.body?.panels !== undefined) {
    ws.set("sharePanels", readPanels(req.body.panels));
  }
  await ws.save();

  res.json({
    enabled: Boolean(ws.get("shareEnabled")),
    token: ws.get("shareToken") ?? null,
    panels: readPanels(ws.get("sharePanels")),
    views: ws.get("shareViews") ?? 0,
    lastViewedAt: ws.get("shareLastViewedAt") ?? null,
  });
});

// Install status for a site — has the tracking script ever reported?
router.get(
  "/:wid/sites/:siteId/status",
  async (req: AuthedRequest, res: Response) => {
    const ws = await Workspace.findOne({
      _id: req.params.wid,
      userId: req.userId,
    });
    if (!ws) return res.status(404).json({ error: "workspace not found" });
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: ws.id,
    });
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
  },
);

// Aggregate analytics across all sites in a workspace
router.get("/:wid/stats", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).select(
    "siteId name trackerVersion",
  );

  const ids = selectSiteIds(sites, req.query.sites);
  if (ids.length === 0) {
    return res.json({
      range: String(req.query.range ?? "24h"),
      pageviews: 0,
      visitors: 0,
      live: 0,
      topPages: [],
      topReferrers: [],
      devices: [],
      countries: [],
      utmSources: [],
      timeseries: [],
      siteCount: 0,
      outdatedSites: [],
    });
  }

  const inScope = new Set(ids);
  const outdatedSites = sites
    .filter(
      (s) =>
        inScope.has(s.siteId as string) &&
        (s.trackerVersion ?? 1) < TRACKER_VERSION,
    )
    .map((s) => ({ siteId: s.siteId as string, name: s.name as string }));

  const rangeKey = String(req.query.range ?? "24h");
  const win = resolveWindow(rangeKey, req.query.from, req.query.to);
  const filters = parseFilters(req.query.filter);
  const stats = await computeStats(ids, rangeKey, filters, win);

  // Score the workspace's goals over the same window/scope. Goals live on the
  // workspace, so they're resolved here rather than inside computeStats (which
  // only knows about siteIds).
  const goalDefs = await Goal.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  const goals = await computeGoals(
    ids,
    goalDefs.map<GoalDef>((g) => ({
      id: g.id,
      name: g.get("name"),
      kind: g.get("kind"),
      match: g.get("match"),
    })),
    rangeKey,
    stats.visitors,
    {},
    win,
  );

  res.json({
    ...stats,
    goals,
    siteCount: ids.length,
    outdatedSites,
    filters,
    // Echo the resolved window so a custom range round-trips to the client.
    window: { since: win.since, until: win.until },
  });
});

// Export raw events as CSV or XLSX for the current window/scope.
router.get("/:wid/export", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);

  const rangeKey = String(req.query.range ?? "24h");
  const win = resolveWindow(rangeKey, req.query.from, req.query.to);
  const filters = parseFilters(req.query.filter);
  const format = req.query.format === "csv" ? "csv" : "xlsx";

  const rows = ids.length ? await exportEvents(ids, win, filters) : [];

  const stamp = win.since.toISOString().slice(0, 10);
  const base = `quantalog-events-${stamp}`;

  if (format === "csv") {
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      // Quote when the value contains a comma, quote, or newline; double inner quotes.
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = EXPORT_COLUMNS.join(",");
    const body = rows.map((r) => EXPORT_COLUMNS.map((c) => esc(r[c])).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    return res.send(`${header}\n${body}`);
  }

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Events");
  sheet.columns = EXPORT_COLUMNS.map((c) => ({ header: c, key: c, width: 18 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// --- goal definitions (conversions) -------------------------------------
router.get("/:wid/goals", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const goals = await Goal.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  res.json(
    goals.map((g) => ({
      id: g.id,
      name: g.get("name"),
      kind: g.get("kind"),
      match: g.get("match"),
    })),
  );
});

router.post("/:wid/goals", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const kind = req.body?.kind === "event" ? "event" : "page";
  const match = String(req.body?.match ?? "").trim().slice(0, 300);
  if (!name || !match) return res.status(400).json({ error: "name and match required" });

  const goal = await Goal.create({ workspaceId: ws.id, name, kind, match });
  res.status(201).json({ id: goal.id, name, kind, match });
});

router.delete("/:wid/goals/:gid", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const goal = await Goal.findOne({ _id: req.params.gid, workspaceId: ws.id });
  if (!goal) return res.status(404).json({ error: "goal not found" });
  await goal.deleteOne();
  res.status(204).end();
});

router.post("/:wid/funnel", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
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
  const ids = selectSiteIds(sites, req.body?.sites);
  if (ids.length === 0) return res.json({ steps: [] });

  const rangeKey = String(req.body?.range ?? "24h");
  const win = resolveWindow(rangeKey, req.body?.from, req.body?.to);
  const result = await computeFunnel(ids, steps, rangeKey, win);
  res.json({ steps: result });
});

// Weekly retention cohorts for the workspace.
router.get("/:wid/retention", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
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
    { new: true },
  );
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  res.json(ws);
});

// Delete workspace + its sites + their events
router.delete("/:wid", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  await Event.deleteMany({ siteId: { $in: ids } });
  await Site.deleteMany({ workspaceId: ws.id });
  await Goal.deleteMany({ workspaceId: ws.id });
  // Keys are scoped to the workspace, so they'd otherwise outlive it and keep
  // authenticating against /v1 for a tenant that no longer exists.
  await ApiKey.deleteMany({ workspaceId: ws.id });
  await Project.deleteMany({ workspaceId: ws.id });
  await ws.deleteOne();
  res.status(204).end();
});

// Delete a single site + its events
router.delete(
  "/:wid/sites/:siteId",
  async (req: AuthedRequest, res: Response) => {
    const ws = await Workspace.findOne({
      _id: req.params.wid,
      userId: req.userId,
    });
    if (!ws) return res.status(404).json({ error: "workspace not found" });
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: ws.id,
    });
    if (!site) return res.status(404).json({ error: "site not found" });
    await Event.deleteMany({ siteId: site.siteId });
    await site.deleteOne();
    res.status(204).end();
  },
);

type Placed = { id: string; span: number };

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
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  // null, not [], so the client can tell "never customised" from "emptied".
  res.json({ layout: ws.homeLayout ?? null });
});

router.put("/:wid/layout", async (req: AuthedRequest, res: Response) => {
  const layout = parseLayout(req.body);
  if (!layout)
    return res
      .status(400)
      .json({ error: "layout must be an array of { id, span: 1|2|3|4 }" });
  const ws = await Workspace.findOneAndUpdate(
    { _id: req.params.wid, userId: req.userId },
    { homeLayout: layout },
    { new: true },
  );
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  res.json({ layout: ws.homeLayout ?? [] });
});

// ---- API keys (platform integration) ----
// Create a key — returns the raw secret ONCE.
router.post("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
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
  res.status(201).json({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    key: raw,
    createdAt: key.createdAt,
  });
});

// List keys (masked — never returns the raw secret again)
router.get("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const keys = await ApiKey.find({ workspaceId: ws.id, revoked: false }).sort({
    createdAt: -1,
  });
  res.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.get("createdAt"),
    })),
  );
});

// Revoke a key
router.delete("/:wid/keys/:kid", async (req: AuthedRequest, res: Response) => {
  const ws = await Workspace.findOne({
    _id: req.params.wid,
    userId: req.userId,
  });
  if (!ws) return res.status(404).json({ error: "workspace not found" });
  const key = await ApiKey.findOne({ _id: req.params.kid, workspaceId: ws.id });
  if (!key) return res.status(404).json({ error: "key not found" });
  key.set("revoked", true);
  await key.save();
  res.status(204).end();
});

export default router;
