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
import { planLimit } from "../plan-limit.js";
import {
  computeStats,
  computeFunnel,
  computeUserFlow,
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
  computeLive,
  type FunnelStep,
  type GoalDef,
} from "../../modules/analytics/stats.service.js";
import ExcelJS from "exceljs";
import { ApiKey } from "../../modules/identity/models/ApiKey.js";
import { Goal } from "../../modules/analytics/models/Goal.js";
import { Funnel } from "../../modules/analytics/models/Funnel.js";
import { Project } from "../../modules/workspace/models/Project.js";
import { generateKey } from "../middleware/api-key.js";
import { canCreateSite, canUseRange, canUseCompare, currentPlan, assignFreePlan, quotaSummary } from "../../modules/billing/quota.service.js";
import { invalidateSite } from "../../modules/billing/event-quota.js";
import { Subscription } from "../../modules/billing/models/Subscription.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import { WorkspaceInvite } from "../../modules/workspace/models/WorkspaceInvite.js";
import { resolveAccess, isDenied, accessibleWorkspaces, requireWorkspace } from "../../modules/workspace/access.service.js";

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
  const { name, platform, domain, framework, bundleId, trackerOptions } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  // Web sites are still domain-bound (that's what the tracker snippet installs
  // against); app sites are identified by bundleId instead.
  if (platform !== "app" && !domain)
    return res.status(400).json({ error: "domain required" });

  const allowed = await canCreateSite(ws.id);
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

  const site = await Site.create({
    workspaceId: ws.id,
    userId: req.userId,
    name,
    platform: platform === "app" ? "app" : "web",
    domain: domain ?? "",
    framework: framework ?? "other",
    bundleId: bundleId ?? "",
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
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

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
 * Visitors online right now, and nothing else.
 *
 * The same figure is already in the stats payload, but that payload is thirty
 * aggregations over the selected range — far too heavy to ask for at the rate
 * a number labelled "online now" should refresh. This is two queries over a
 * five-minute window, so the dashboard can poll it on a short cycle and leave
 * the full stats on a slow one.
 *
 * Range and comparison are meaningless here: the window is always the last five
 * minutes. Site selection and filters still apply, so the number matches the
 * scope the rest of the dashboard is showing.
 */
router.get("/:wid/live", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const sites = await Site.find({ workspaceId: access.workspace.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (ids.length === 0) return res.json({ live: 0, livePages: [] });

  res.json(await computeLive(ids, parseFilters(req.query.filter)));
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
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

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
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

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

// --- identified users / journey tracing (dashboard read side) -----------
//
// The write side lives on the Platform API (/v1/track — API-key authed, for
// a customer's own web/mobile app). These are the session-authed reads the
// dashboard itself uses to show that data, same underlying Event rows,
// scoped through the caller's workspace membership instead of a key.

/** Recently active identified users, most recent first. */
router.get("/:wid/users", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (!ids.length) return res.json({ users: [], total: 0, page: 1, pageSize: 10 });

  const search = String(req.query.q ?? "").trim().slice(0, 120);
  const pageSize = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);

  // Recency is the default because the support question this list answers —
  // "what did the person who just wrote in do?" — is nearly always about
  // someone active minutes ago. Volume and first-seen are the two other ways
  // people arrive at a specific user.
  const sortKey = String(req.query.sort ?? "recent");
  const sortStage: Record<string, 1 | -1> =
    sortKey === "events" ? { eventCount: -1 } :
    sortKey === "new" ? { firstSeen: -1 } :
    { lastSeen: -1 };

  // "Active" is the window the summary counts against, and the one an
  // `active` filter narrows the list to. A day matches how support tickets
  // arrive; anything longer stops being a useful "who is here now".
  const activeSince = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [result] = await Event.aggregate([
    {
      $match: {
        siteId: { $in: ids },
        // `$ne: ""` alone still let through null and whitespace-only ids,
        // which surfaced as a nameless row nobody could act on.
        appUserId: {
          $nin: [null, ""],
          ...(search
            ? { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" }
            : { $regex: /\S/ }),
        },
      },
    },
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: "$appUserId",
        lastSeen: { $first: "$ts" },
        firstSeen: { $last: "$ts" },
        lastAction: { $first: "$name" },
        siteId: { $first: "$siteId" },
        eventCount: { $sum: 1 },
        // A visit count reads as activity in a way a raw event total never
        // does: 40 events over 12 sessions is a regular, 40 in one is a
        // single frantic afternoon.
        sessions: { $addToSet: "$sessionId" },
      },
    },
    {
      $addFields: {
        sessionCount: { $size: { $filter: { input: "$sessions", cond: { $ne: ["$$this", null] } } } },
      },
    },
    { $project: { sessions: 0 } },
    ...(String(req.query.filter) === "active"
      ? [{ $match: { lastSeen: { $gte: activeSince } } }]
      : []),
    { $sort: sortStage },
    {
      // One round trip for the page, the count it's paged against, and the
      // summary above it — three queries could disagree if a user is traced
      // between them.
      $facet: {
        users: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        total: [{ $count: "count" }],
        summary: [
          {
            $group: {
              _id: null,
              users: { $sum: 1 },
              events: { $sum: "$eventCount" },
              active: { $sum: { $cond: [{ $gte: ["$lastSeen", activeSince] }, 1, 0] } },
            },
          },
        ],
      },
    },
  ]);

  const summary = result?.summary?.[0];

  res.json({
    users: (result?.users ?? []).map((u: any) => ({
      appUserId: u._id,
      lastSeen: u.lastSeen,
      firstSeen: u.firstSeen,
      lastAction: u.lastAction,
      siteId: u.siteId,
      eventCount: u.eventCount,
      sessionCount: u.sessionCount,
    })),
    total: result?.total?.[0]?.count ?? 0,
    summary: {
      users: summary?.users ?? 0,
      events: summary?.events ?? 0,
      activeToday: summary?.active ?? 0,
    },
    page,
    pageSize,
  });
});

/** One user's full journey, oldest first: every src -> action -> dest step. */
router.get("/:wid/track/:appUserId", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const appUserId = String(req.params.appUserId ?? "").trim();
  if (!appUserId) return res.status(400).json({ error: "appUserId required" });

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (!ids.length) return res.json({ appUserId, events: [] });

  const limit = Math.min(Number(req.query.limit) || 500, 1000);

  const events = await Event.find({ siteId: { $in: ids }, appUserId })
    .sort({ ts: 1 })
    .limit(limit)
    .select("siteId name source destination sessionId ts");

  res.json({
    appUserId,
    events: events.map((e) => ({
      siteId: e.get("siteId"),
      action: e.get("name"),
      src: e.get("source"),
      dest: e.get("destination"),
      // Lets the dashboard group a journey into sessions rather than
      // inferring them from time gaps, which guesses wrong across a long
      // idle period that was really one continuous visit.
      sessionId: e.get("sessionId"),
      ts: e.get("ts"),
    })),
  });
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
    return planLimit(
      res,
      "funnels need this workspace on the Starter or Pro plan",
      { kind: "funnels", label: "Funnels", plan: plan?.name },
      "plan_required",
    );
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
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

  const win = resolveWindow(rangeKey, req.body?.from, req.body?.to);
  const result = await computeFunnel(ids, steps, rangeKey, win);
  res.json({ steps: result });
});

// --- saved funnel definitions --------------------------------------------
function parseFunnelSteps(raw: unknown): FunnelStep[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((s: { type?: string; value?: string }) => ({
      type: s?.type === "event" ? ("event" as const) : ("page" as const),
      value: String(s?.value ?? "").slice(0, 300),
    }))
    .filter((s) => s.value)
    .slice(0, 8);
}

router.get("/:wid/funnels", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const funnels = await Funnel.find({ workspaceId: ws.id }).sort({ createdAt: 1 });
  res.json(
    funnels.map((f) => ({
      id: f.id,
      name: f.get("name"),
      steps: f.get("steps"),
    })),
  );
});

router.post("/:wid/funnels", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const steps = parseFunnelSteps(req.body?.steps);
  if (!name) return res.status(400).json({ error: "name required" });
  if (steps.length < 2) return res.status(400).json({ error: "at least 2 steps required" });

  const funnel = await Funnel.create({ workspaceId: ws.id, name, steps });
  res.status(201).json({ id: funnel.id, name, steps });
});

router.put("/:wid/funnels/:fid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const steps = parseFunnelSteps(req.body?.steps);
  if (!name) return res.status(400).json({ error: "name required" });
  if (steps.length < 2) return res.status(400).json({ error: "at least 2 steps required" });

  const funnel = await Funnel.findOne({ _id: req.params.fid, workspaceId: ws.id });
  if (!funnel) return res.status(404).json({ error: "funnel not found" });
  funnel.set({ name, steps });
  await funnel.save();
  res.json({ id: funnel.id, name, steps });
});

router.delete("/:wid/funnels/:fid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const funnel = await Funnel.findOne({ _id: req.params.fid, workspaceId: ws.id });
  if (!funnel) return res.status(404).json({ error: "funnel not found" });
  await funnel.deleteOne();
  res.status(204).end();
});

// Page-to-page navigation graph for the workspace.
router.get("/:wid/user-flow", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const ids = selectSiteIds(sites, req.query.sites);
  if (ids.length === 0) return res.json({ nodes: [], edges: [] });

  const rangeKey = String(req.query.range ?? "24h");
  const allowed = await canUseRange(ws.id, rangeKey);
  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

  const win = resolveWindow(rangeKey, req.query.from, req.query.to);
  const result = await computeUserFlow(ids, rangeKey, win);
  res.json(result);
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

/**
 * Appearance (theme) settings, workspace-scoped — same shape as the client's
 * ThemePrefs. Stored as a plain object rather than validated field-by-field:
 * the FE owns what the keys mean and what a valid value looks like for each
 * one, and a strict schema here would need editing every time Appearance
 * grows a new control. The size cap and plain-object check are the only
 * gates, matching how `homeLayout` above trusts its item shape beyond a
 * basic type check.
 */
function parseThemePrefs(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  if (JSON.stringify(body).length > 4000) return null;
  return body as Record<string, unknown>;
}

router.get("/:wid/theme", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  // null, not {}, so the client can tell "never customised" from "reset".
  res.json({ theme: ws.themePrefs ?? null });
});

router.put("/:wid/theme", async (req: AuthedRequest, res: Response) => {
  const theme = parseThemePrefs(req.body);
  if (!theme)
    return res.status(400).json({ error: "theme must be a plain object" });
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const ws = await Workspace.findByIdAndUpdate(
    access.workspace.id,
    { themePrefs: theme },
    { new: true },
  );
  res.json({ theme: ws?.themePrefs ?? null });
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
