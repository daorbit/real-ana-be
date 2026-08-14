import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { Event } from "../../modules/analytics/models/Event.js";
import { SeoReport } from "../../modules/seo/models/SeoReport.js";
import { Competitor } from "../../modules/seo/models/Competitor.js";
import { CompetitorSnapshot } from "../../modules/seo/models/CompetitorSnapshot.js";
import { CrawlReport } from "../../modules/seo/models/CrawlReport.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import {
  computeStats,
  computeFunnel,
  computeRetention,
  computeGoals,
  exportEvents,
  resolveWindow,
  parseFilters,
  parseCompareMode,
  compareBreakdown,
  COMPARABLE_DIMENSION_KEYS,
  EXPORT_COLUMNS,
  TRACKER_VERSION,
  type FunnelStep,
  type GoalDef,
} from "../../modules/analytics/stats.service.js";
import ExcelJS from "exceljs";
import { ApiKey } from "../../modules/identity/models/ApiKey.js";
import { Goal } from "../../modules/analytics/models/Goal.js";
import { Project } from "../../modules/workspace/models/Project.js";
import { generateKey } from "../middleware/api-key.js";
import { canCreateSite, canUseRange, canUseCompare, currentPlan, assignFreePlan, quotaSummary } from "../../modules/billing/quota.service.js";
import { invalidateSite } from "../../modules/billing/event-quota.js";
import { Subscription } from "../../modules/billing/models/Subscription.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import { WorkspaceInvite } from "../../modules/workspace/models/WorkspaceInvite.js";
import { resolveAccess, isDenied, accessibleWorkspaces, requireWorkspace } from "../../modules/workspace/access.service.js";
import { askOrbit, orbitConfigured } from "../../modules/orbit/index.js";
import { quantalogOrbitHost } from "../../modules/orbit/orbit-host.js";

const router = Router();
router.use(requireAuth);
// A demo session may read every workspace route but write none.
router.use(blockDemoWrites);

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

/**
 * Create a workspace.
 *
 * Uncapped: a workspace is the billable unit, so there is no account-wide
 * allowance to check — the account simply ends up with another workspace on the
 * Free plan, which it can upgrade separately.
 *
 * The Free plan is assigned immediately rather than left for the first
 * purchase, because every quota check reads the workspace's own subscription
 * and a workspace without one would 402 on every route the moment it was made.
 */
router.post("/", async (req: AuthedRequest, res: Response) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });

  try {
    const ws = await Workspace.create({
      userId: req.userId,
      name,
      slug: slugify(name) || nanoid(6),
    });
    // The creator's own membership. Written here rather than inferred from
    // `Workspace.userId` so that access is one mechanism with one lookup — the
    // owner is a member like everyone else, just the one who cannot be removed.
    await Membership.create({ workspaceId: ws.id, userId: req.userId, role: "owner" });
    await assignFreePlan(ws.id, req.userId as string);
    // Same shape as the list route, so the client can drop it straight into
    // the cache without a second fetch to learn what plan it landed on.
    res.status(201).json({
      ...ws.toObject(),
      role: "owner",
      billing: await quotaSummary(ws.id),
    });
  } catch (err) {
    console.error("createWorkspace failed:", err);
    res.status(500).json({ error: "could not create workspace" });
  }
});

/**
 * The workspaces this account can reach, each with the plan it is on.
 *
 * Billing is attached here rather than to the profile because a plan belongs to
 * a workspace: whichever workspaces this route returns are exactly the ones the
 * caller may spend or upgrade.
 *
 * Driven by membership, so a workspace shared with the caller appears exactly
 * like one they created — with `role` saying which it is, since that decides
 * what the client offers them.
 */
router.get("/", async (req: AuthedRequest, res: Response) => {
  const accessible = await accessibleWorkspaces(req.userId as string);

  res.json(
    await Promise.all(
      accessible.map(async ({ workspace, role }) => ({
        ...workspace.toObject(),
        role,
        billing: await quotaSummary(workspace.id),
      })),
    ),
  );
});

/**
 * One workspace's plan and usage, on its own.
 *
 * The same `billing` object the list route attaches to every workspace, but
 * reachable without refetching the list. Usage changes constantly — every
 * audit, crawl and Orbit question moves it — while the list around it (names,
 * roles, membership) almost never does, so refreshing a counter by refetching
 * every workspace means N subscription lookups and N site counts to update one
 * number.
 *
 * That cost is why counters went stale rather than being refreshed: the cheap
 * correct call did not exist, so nothing called it.
 */
router.get("/:wid/usage", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const summary = await quotaSummary(ws.id);
  // Null means no subscription row, which should not happen — creating a
  // workspace assigns Free — but a 404 says so honestly rather than handing the
  // client a null it will read as "no quota left".
  if (!summary) return res.status(404).json({ error: "this workspace has no billing record" });

  res.json(summary);
});

// Create site under workspace
router.post("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const { name, domain, framework, trackerOptions } = req.body ?? {};
  if (!name || !domain)
    return res.status(400).json({ error: "name, domain required" });

  const allowed = await canCreateSite(ws.id);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

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
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
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
    const access = await resolveAccess(req, "editor");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: access.workspace.id,
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

/** The owner-facing share state, assembled the same way from GET and PUT. */
function shareState(ws: NonNullable<Awaited<ReturnType<typeof Workspace.findOne>>>) {
  return {
    enabled: Boolean(ws.get("shareEnabled")),
    token: ws.get("shareToken") ?? null,
    panels: readPanels(ws.get("sharePanels")),
    views: ws.get("shareViews") ?? 0,
    lastViewedAt: ws.get("shareLastViewedAt") ?? null,
  };
}

/** Current share state for a workspace. */
router.get("/:wid/share", async (req: AuthedRequest, res: Response) => {
  // Admin to even see it: the token in this response *is* the public link, so
  // reading it is equivalent to being handed one.
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  res.json(shareState(access.workspace));
});

/**
 * Turn sharing on or off, optionally minting a fresh token.
 *
 * `rotate` is the only way to invalidate a link that has already been sent
 * somewhere — disabling alone keeps the token so the same URL can be brought
 * back, which is what someone toggling visibility usually wants.
 */
router.put("/:wid/share", async (req: AuthedRequest, res: Response) => {
  // Publishing a workspace's traffic to anyone with a URL is not day-to-day
  // editing — it needs someone trusted with the workspace itself.
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

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

  res.json(shareState(ws));
});

/** Long enough for a LinkedIn caption, short enough to bound the model call. */
const MAX_CAPTION_CHARS = 3000;

/** The networks a caption can be written for, and how each one wants to read. */
const CAPTION_TONES: Record<string, string> = {
  linkedin:
    "LinkedIn: a professional but human first-person post. Three or four short paragraphs, a concrete hook in the first line, and three or four relevant hashtags at the end.",
  facebook:
    "Facebook: warm and conversational, two or three short paragraphs, at most two hashtags.",
  twitter:
    "X (Twitter): one punchy post under 240 characters including the link, at most two hashtags.",
  whatsapp:
    "WhatsApp: a short direct message to a colleague. Two or three sentences, no hashtags.",
  telegram:
    "Telegram: brief and informative, two or three sentences, no hashtags.",
};

/**
 * Write a share caption.
 *
 * Runs through Orbit's model plumbing — the fallback chain, the timeouts, the
 * output sanitising — with its own system prompt, because under the support
 * prompt the model correctly refuses "write me a post" as off-topic.
 *
 * Admin-only, like the rest of sharing: this is metered model spend against the
 * workspace, and the caption describes numbers only an admin can publish.
 *
 * Everything the model is told comes from the server's own record of the
 * workspace, not from the request. A client that could supply the figures could
 * also supply instructions, and the caption goes out under the user's name.
 */
router.post("/:wid/share/caption", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Caption writing is not available on this server." });
  }

  if (!ws.get("shareEnabled") || !ws.get("shareToken")) {
    return res.status(400).json({ error: "Turn the public dashboard on first." });
  }

  const platform = String(req.body?.platform ?? "linkedin");
  const tone = CAPTION_TONES[platform];
  if (!tone) return res.status(400).json({ error: "Unsupported platform." });

  // The figures come from the same place the public page gets them, so the
  // caption cannot claim numbers the link does not actually show.
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const siteIds = sites.map((s) => s.siteId as string);
  const stats = siteIds.length
    ? await computeStats(siteIds, "30d", {}, resolveWindow("30d"))
    : null;

  const publicUrl = `${process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in"}/share/${ws.get("shareToken")}`;

  // Only panels the owner published may be described. Mentioning a breakdown
  // that is switched off would send people to a page missing what was promised.
  const panels = readPanels(ws.get("sharePanels"));
  const visible = Object.entries(panels)
    .filter(([, on]) => on)
    .map(([key]) => key)
    .join(", ");

  const facts = [
    `Workspace name: ${ws.get("name")}`,
    `Public dashboard URL: ${publicUrl}`,
    stats && panels.totals
      ? `Last 30 days: ${stats.visitors} visitors, ${stats.pageviews} pageviews.`
      : "Visitor totals are not published on this dashboard — do not quote any figures.",
    `Sections the page shows: ${visible || "none"}.`,
  ].join("\n");

  const result = await askOrbit(
    `Write the caption.\n\n${facts}`,
    {
      systemPrompt:
        "You write social media captions for people sharing their public web-analytics dashboard, which is hosted on a product called Quantalog. " +
        `Write for ${tone}\n\n` +
        "Rules: write in the first person as the dashboard's owner. Use only the facts given — never invent figures, dates or claims. " +
        "Include the dashboard URL exactly as provided, on its own line. Do not use markdown, headings, bullet characters or quotation marks around the caption. " +
        "Return the caption in the `reply` field and an empty `suggestions` array.",
      host: quantalogOrbitHost,
      tenantId: ws.id,
    },
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.json({ caption: result.reply.trim().slice(0, MAX_CAPTION_CHARS) });
});

// Install status for a site — has the tracking script ever reported?
router.get(
  "/:wid/sites/:siteId/status",
  async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req);
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const ws = access.workspace;
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
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
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
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  // A baseline the plan doesn't include degrades to "previous" rather than
  // refusing the request — see `canUseCompare`.
  const askedCompare = parseCompareMode(req.query.compare);
  const compare = (await canUseCompare(ws.id, askedCompare)) ? askedCompare : "previous";

  const win = resolveWindow(
    rangeKey,
    req.query.from,
    req.query.to,
    compare,
    req.query.compareFrom,
    req.query.compareTo,
  );
  const filters = parseFilters(req.query.filter);
  // The overlay series is only worth its extra aggregation when the client is
  // actually drawing a comparison.
  const stats = await computeStats(ids, rangeKey, filters, win, compare !== "previous");

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
    // Echo the baseline actually used, which may not be the one asked for if
    // the plan does not include it — the picker reads this back to stay honest
    // about what is on screen.
    compare: win.compare,
  });
});

/**
 * One breakdown, current window against its baseline.
 *
 * Separate from the stats payload because comparing every breakdown would
 * double roughly twenty-five aggregations to serve a panel the user may never
 * open. The dashboard calls this per panel, on expand.
 */
router.get("/:wid/stats/compare", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const dimension = String(req.query.dimension ?? "");
  if (!COMPARABLE_DIMENSION_KEYS.includes(dimension)) {
    return res.status(400).json({ error: `unknown dimension: ${dimension}` });
  }

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (!ids.length) return res.json({ dimension, rows: [] });

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const askedCompare = parseCompareMode(req.query.compare);
  const compare = (await canUseCompare(ws.id, askedCompare)) ? askedCompare : "previous";

  const win = resolveWindow(
    rangeKey,
    req.query.from,
    req.query.to,
    compare,
    req.query.compareFrom,
    req.query.compareTo,
  );
  const filters = parseFilters(req.query.filter);
  const rows = await compareBreakdown(ids, dimension, win, filters);

  res.json({ dimension, compare: win.compare, rows });
});

// Export raw events as CSV or XLSX for the current window/scope.
router.get("/:wid/export", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

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
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
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
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const kind = req.body?.kind === "event" ? "event" : "page";
  const match = String(req.body?.match ?? "").trim().slice(0, 300);
  if (!name || !match) return res.status(400).json({ error: "name and match required" });

  const goal = await Goal.create({ workspaceId: ws.id, name, kind, match });
  res.status(201).json({ id: goal.id, name, kind, match });
});

router.delete("/:wid/goals/:gid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const goal = await Goal.findOne({ _id: req.params.gid, workspaceId: ws.id });
  if (!goal) return res.status(404).json({ error: "goal not found" });
  await goal.deleteOne();
  res.status(204).end();
});

router.post("/:wid/funnel", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  // Funnels are a Starter/Pro feature — Free can view the builder UI but not
  // spend compute on it.
  const plan = await currentPlan(ws.id);
  if (!plan || plan.slug === "free") {
    return res.status(402).json({
      error: "funnels need this workspace on the Starter or Pro plan",
      code: "plan_required",
    });
  }

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
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error, code: "quota_exceeded" });

  const win = resolveWindow(rangeKey, req.body?.from, req.body?.to);
  const result = await computeFunnel(ids, steps, rangeKey, win);
  res.json({ steps: result });
});

// Weekly retention cohorts for the workspace.
router.get("/:wid/retention", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

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

  // Admin, not editor: the name is how every member identifies the workspace,
  // so renaming it changes what everyone else is looking at.
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const ws = await Workspace.findByIdAndUpdate(
    access.workspace.id,
    { name, slug: slugify(name) || nanoid(6) },
    { new: true },
  );
  res.json(ws);
});

// Delete workspace + its sites + their events
router.delete("/:wid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "owner");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = sites.map((s) => s.siteId as string);
  await Event.deleteMany({ siteId: { $in: ids } });
  await SeoReport.deleteMany({ workspaceId: ws.id });
  await Competitor.deleteMany({ workspaceId: ws.id });
  // Trend rows carry no workspace id, so they are cleared by the site ids the
  // workspace owned — otherwise they outlive both and are unreachable.
  await CompetitorSnapshot.deleteMany({ siteId: { $in: ids } });
  await CrawlReport.deleteMany({ workspaceId: ws.id });
  await Site.deleteMany({ workspaceId: ws.id });
  await Goal.deleteMany({ workspaceId: ws.id });
  // Keys are scoped to the workspace, so they'd otherwise outlive it and keep
  // authenticating against /v1 for a tenant that no longer exists.
  await ApiKey.deleteMany({ workspaceId: ws.id });
  await Project.deleteMany({ workspaceId: ws.id });
  // The plan was bought for this workspace, so it goes with it. Left behind it
  // would hold the unique index on `workspaceId` against a dead id, and count
  // as an active plan in the account's billing summary.
  await Subscription.deleteOne({ workspaceId: ws.id });
  // Everyone's access to it, and any invitations still outstanding — an
  // unaccepted link must not resurrect a membership for a workspace that no
  // longer exists.
  await Membership.deleteMany({ workspaceId: ws.id });
  await WorkspaceInvite.deleteMany({ workspaceId: ws.id });
  await ws.deleteOne();
  // Ingest caches "this site may collect" for a minute. Without this a deleted
  // site keeps accepting beacons until that expires, writing events keyed to a
  // site that no longer exists — rows nothing can read or clean up.
  for (const id of ids) invalidateSite(id);
  res.status(204).end();
});

// Delete a single site + its events
router.delete(
  "/:wid/sites/:siteId",
  async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "editor");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const ws = access.workspace;
    const site = await Site.findOne({
      siteId: req.params.siteId,
      workspaceId: ws.id,
    });
    if (!site) return res.status(404).json({ error: "site not found" });
    await Event.deleteMany({ siteId: site.siteId });
    await SeoReport.deleteMany({ siteId: site.siteId });
    await Competitor.deleteMany({ siteId: site.siteId });
    await CompetitorSnapshot.deleteMany({ siteId: site.siteId });
    await CrawlReport.deleteMany({ siteId: site.siteId });
    await site.deleteOne();
    // See the workspace delete above: a cached allow decision would otherwise
    // let this site keep ingesting for up to a minute after it is gone.
    invalidateSite(site.siteId as string);
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
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  // null, not [], so the client can tell "never customised" from "emptied".
  res.json({ layout: ws.homeLayout ?? null });
});

router.put("/:wid/layout", async (req: AuthedRequest, res: Response) => {
  const layout = parseLayout(req.body);
  if (!layout)
    return res
      .status(400)
      .json({ error: "layout must be an array of { id, span: 1|2|3|4 }" });
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const ws = await Workspace.findByIdAndUpdate(
    access.workspace.id,
    { homeLayout: layout },
    { new: true },
  );
  res.json({ layout: ws?.homeLayout ?? [] });
});

// ---- API keys (platform integration) ----
// Create a key — returns the raw secret ONCE.
router.post("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
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
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
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
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const key = await ApiKey.findOne({ _id: req.params.kid, workspaceId: ws.id });
  if (!key) return res.status(404).json({ error: "key not found" });
  key.set("revoked", true);
  await key.save();
  res.status(204).end();
});

export default router;
