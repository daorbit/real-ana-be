import { Router, Response } from "express";
import { nanoid } from "nanoid";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { Site } from "../../modules/analytics/models/Site.js";
import { Event } from "../../modules/analytics/models/Event.js";
import { fillMissingFirstEvents } from "../../modules/analytics/site-first-event.js";
import { parseSiteLogoUrl, uploadSiteLogo } from "../../modules/analytics/site-logo.js";
import { cloudinaryConfigured } from "../../infra/storage/cloudinary.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { generateOnboardingCopy, onboardingCopyReady } from "../../modules/onboarding-ai/generate.js";
import { planLimit } from "../plan-limit.js";
import { guardSiteCreation } from "../site-limit.js";
import {
  computeStats,
  computeFunnel,
  computeUserFlow,
  computeRetention,
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
} from "../../modules/analytics/stats.service.js";
import ExcelJS from "exceljs";
import { ApiKey } from "../../modules/identity/models/ApiKey.js";
import { Funnel } from "../../modules/analytics/models/Funnel.js";
import { generateKey, expiryFromDays } from "../middleware/api-key.js";
import { parseUsageWindow, workspaceKeyUsage } from "../../modules/identity/api-key-usage.service.js";
import { decryptApiKey, loadRevealTarget } from "../../modules/identity/api-key-reveal.service.js";
import { hasOwnershipFactor, rejectUnconfirmed } from "../../modules/security/confirm-identity.service.js";
import { canUseRange, canUseCompare, currentPlan, assignFreePlan, quotaSummary } from "../../modules/billing/quota.service.js";
import { usageHistory } from "../../modules/billing/usage-history.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import { resolveAccess, isDenied, accessibleWorkspaces, requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import { newShareToken } from "../../modules/analytics/public-dashboard.service.js";
import { readSharePanels } from "../../modules/analytics/share-panels.js";
import { siteEventSummary } from "../../modules/analytics/site-event-summary.js";
import { parseLayout } from "../../modules/workspace/layout.js";
import { toPublicNavPrefs } from "../../modules/workspace/nav-prefs.service.js";
import { purgeSite, purgeWorkspaces } from "../../modules/workspace/purge.service.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { recordAudit } from "../../modules/audit/audit.service.js";
import { bareDomain } from "../../modules/backlinks/domains.js";

const STATS_CACHE_MS = 10_000;
const statsCache = createTtlCache<Record<string, unknown>>(STATS_CACHE_MS, 500);

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
    heatmap: !!o.heatmap,
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
    await Promise.all([
      assignFreePlan(ws.id, req.userId as string),
      recordAudit(req, {
        action: "workspace.created",
        workspaceId: ws.id,
        target: { kind: "workspace", id: ws.id, label: ws.name },
      }),
    ]);
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
        navPrefs: toPublicNavPrefs(workspace.get("navPrefs")),
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

router.get("/:wid/usage/history", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const history = await usageHistory(ws.id);
  if (!history) return res.status(404).json({ error: "this workspace has no billing record" });

  res.json(history);
});

// Create site under workspace
router.post("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const { name, platform, domain, framework, bundleId, trackerOptions, purpose, logoUrl } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  const logo = parseSiteLogoUrl(logoUrl);
  if (logo === null) return res.status(400).json({ error: "the logo must be an https image URL" });
  // Web sites are still domain-bound (that's what the tracker snippet installs
  // against); app sites are identified by bundleId instead.
  if (platform !== "app" && !domain)
    return res.status(400).json({ error: "domain required" });

  if (!(await guardSiteCreation(res, ws.id))) return;

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
    purpose: typeof purpose === "string" ? purpose.trim().slice(0, 140) : "",
    logoUrl: logo,
  });
  await recordAudit(req, {
    action: "site.added",
    workspaceId: ws.id,
    target: { kind: "site", id: site.siteId as string, label: site.name as string },
    meta: { domain: (site.domain as string) || (site.bundleId as string) || "" },
  });
  res.status(201).json(site);
});

/**
 * One-shot, free, ungated: a short headline/description for the onboarding
 * "you're ready" screen, personalized to the site just created. Never blocks
 * onboarding — the caller falls back to static copy on a 503/502/timeout.
 */
router.post("/:wid/onboarding-ai/copy", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  if (!onboardingCopyReady()) {
    return res.status(503).json({ error: "onboarding copy is not configured" });
  }

  const { siteName, domain, framework, purpose } = req.body ?? {};
  if (typeof siteName !== "string" || !siteName.trim()) {
    return res.status(400).json({ error: "siteName required" });
  }
  if (typeof purpose === "string" && purpose.length > 140) {
    return res.status(400).json({ error: "purpose too long" });
  }

  const result = await generateOnboardingCopy({
    siteName,
    domain: typeof domain === "string" ? domain : "",
    framework: typeof framework === "string" ? framework : "",
    purpose: typeof purpose === "string" ? purpose : "",
  });

  if (!result.ok) return res.status(502).json({ error: "could not generate copy" });
  res.json({ readyHeadline: result.readyHeadline, readyDescription: result.readyDescription });
});

router.post("/:wid/site-logo", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  if (!cloudinaryConfigured()) return res.status(503).json({ error: "image uploads are not configured" });

  const dataUrl = String(req.body?.file ?? "");
  if (!dataUrl) return res.status(400).json({ error: "file required" });

  const result = await uploadSiteLogo(access.workspace.id, dataUrl);
  if ("error" in result) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

// List sites in workspace
router.get("/:wid/sites", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const sites = await Site.find({ workspaceId: ws.id }).sort({ createdAt: -1 });
  await fillMissingFirstEvents(sites);
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

const DOMAIN_PATTERN = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;

router.patch(
  "/:wid/sites/:siteId",
  async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "editor");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const ws = access.workspace;
    const site = await Site.findOne({ siteId: req.params.siteId, workspaceId: ws.id });
    if (!site) return res.status(404).json({ error: "site not found" });

    const { name, domain, logoUrl } = req.body ?? {};
    const before = { name: site.name as string, domain: site.domain as string, logoUrl: site.get("logoUrl") as string };

    if (logoUrl !== undefined) {
      const logo = parseSiteLogoUrl(logoUrl);
      if (logo === null) return res.status(400).json({ error: "the logo must be an https image URL" });
      site.set("logoUrl", logo);
    }

    if (name !== undefined) {
      const nextName = String(name).trim().slice(0, 60);
      if (!nextName) return res.status(400).json({ error: "name required" });
      site.set("name", nextName);
    }

    if (domain !== undefined) {
      const nextDomain = bareDomain(String(domain)).replace(/\.$/, "");
      if (site.platform !== "app" && !nextDomain) return res.status(400).json({ error: "domain required" });
      if (nextDomain && (nextDomain.length > 253 || !DOMAIN_PATTERN.test(nextDomain)))
        return res.status(400).json({ error: "enter a valid domain, like example.com" });
      if (nextDomain && nextDomain !== before.domain) {
        const taken = await Site.exists({ workspaceId: ws.id, domain: nextDomain, siteId: { $ne: site.siteId } });
        if (taken) return res.status(409).json({ error: "a site with that domain already exists in this workspace" });
      }
      site.set("domain", nextDomain);
    }

    await site.save();
    await recordAudit(req, {
      action: "site.updated",
      workspaceId: ws.id,
      target: { kind: "site", id: site.siteId as string, label: site.name as string },
      meta: {
        ...(before.name !== site.name ? { fromName: before.name, toName: site.name as string } : {}),
        ...(before.domain !== site.domain ? { fromDomain: before.domain, toDomain: site.domain as string } : {}),
        ...(before.logoUrl !== site.get("logoUrl") ? { logoChanged: true } : {}),
      },
    });
    res.json(site);
  },
);

/* ---------------------------- public sharing ---------------------------- */

/** The owner-facing share state, assembled the same way from GET and PUT. */
function shareState(ws: NonNullable<Awaited<ReturnType<typeof Workspace.findOne>>>) {
  return {
    enabled: Boolean(ws.get("shareEnabled")),
    token: ws.get("shareToken") ?? null,
    panels: readSharePanels(ws.get("sharePanels")),
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
  if (!appEnabled(access.workspace, "publicDashboard")) {
    return res.status(403).json({ error: APP_DISABLED_MESSAGE.publicDashboard });
  }
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
  if (!appEnabled(ws, "publicDashboard")) {
    return res.status(403).json({ error: APP_DISABLED_MESSAGE.publicDashboard });
  }

  const enabled = Boolean(req.body?.enabled);
  const rotate = Boolean(req.body?.rotate);

  // 32 nanoid chars: the token is the whole credential for an unauthenticated
  // view, so it has to be long enough that guessing is hopeless.
  if (rotate || (enabled && !ws.get("shareToken"))) {
    ws.set("shareToken", newShareToken());
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
    ws.set("sharePanels", readSharePanels(req.body.panels));
  }
  await Promise.all([
    ws.save(),
    recordAudit(req, {
      action: "workspace.share_updated",
      workspaceId: ws.id,
      target: { kind: "share", label: "Public dashboard" },
      meta: { enabled, rotated: rotate },
    }),
  ]);

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
    const { eventCount, lastEventAt } = await siteEventSummary(siteId);

    res.json({
      siteId,
      installed: eventCount > 0,
      eventCount,
      lastEventAt,
      trackerVersion: site.trackerVersion ?? 1,
      latestTrackerVersion: TRACKER_VERSION,
    });
  },
);

// Aggregate analytics across all sites in a workspace
router.get("/:wid/stats", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req);
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const rangeKey = String(req.query.range ?? "24h");
  const askedCompare = parseCompareMode(req.query.compare);

  const [sites, allowed, compareAllowed] = await Promise.all([
    Site.find({ workspaceId: ws.id }).select("siteId name trackerVersion"),
    canUseRange(ws.id, rangeKey),
    canUseCompare(ws.id, askedCompare),
  ]);

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

  if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit);

  // A baseline the plan doesn't include degrades to "previous" rather than
  // refusing the request — see `canUseCompare`.
  const compare = compareAllowed ? askedCompare : "previous";

  const cacheKey = JSON.stringify([
    ws.id,
    ids,
    rangeKey,
    compare,
    req.query.filter ?? null,
    req.query.from ?? null,
    req.query.to ?? null,
    req.query.compareFrom ?? null,
    req.query.compareTo ?? null,
  ]);

  const payload = await statsCache(cacheKey, async () => {
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

    return {
      ...stats,
      filters,
      // Echo the resolved window so a custom range round-trips to the client.
      window: { since: win.since, until: win.until },
      // Echo the baseline actually used, which may not be the one asked for if
      // the plan does not include it — the picker reads this back to stay honest
      // about what is on screen.
      compare: win.compare,
    };
  });

  res.json({ ...payload, siteCount: ids.length, outdatedSites });
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

  const previousName = access.workspace.name;
  const [ws] = await Promise.all([
    Workspace.findByIdAndUpdate(
      access.workspace.id,
      { name, slug: slugify(name) || nanoid(6) },
      { new: true },
    ),
    recordAudit(req, {
      action: "workspace.renamed",
      workspaceId: access.workspace.id,
      target: { kind: "workspace", id: access.workspace.id, label: String(name) },
      meta: { from: previousName, to: String(name) },
    }),
  ]);
  res.json(ws);
});

// Delete workspace + its sites + their events
router.delete("/:wid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "owner");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  await purgeWorkspaces([access.workspace.id]);
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
    await Promise.all([
      purgeSite(site.siteId as string),
      recordAudit(req, {
        action: "site.removed",
        workspaceId: ws.id,
        target: { kind: "site", id: site.siteId as string, label: site.name as string },
        meta: { domain: (site.domain as string) || (site.bundleId as string) || "" },
      }),
    ]);
    res.status(204).end();
  },
);

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
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  const expiresAt = expiryFromDays(req.body?.expiresInDays);
  if (expiresAt === undefined) {
    return res.status(400).json({ error: "expiresInDays must be one of 7, 30, 60, 90, 180, 365 or null" });
  }
  const { raw, keyHash, prefix, keyEnc } = generateKey();
  const key = await ApiKey.create({
    workspaceId: ws.id,
    userId: req.userId,
    name: name || "Default key",
    keyHash,
    prefix,
    keyEnc,
    expiresAt,
  });
  await recordAudit(req, {
    action: "api_key.created",
    workspaceId: ws.id,
    target: { kind: "api_key", id: key.id, label: key.name as string },
    meta: { prefix, expiresInDays: Number(req.body?.expiresInDays) || 0 },
  });
  res.status(201).json({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    key: raw,
    createdAt: key.createdAt,
    expiresAt: key.get("expiresAt") ?? null,
    revealable: true,
  });
});

// List keys (masked — never returns the raw secret again)
router.get("/:wid/keys", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const keys = await ApiKey.find({ workspaceId: ws.id, revoked: false })
    .sort({ createdAt: -1 })
    .select("+keyEnc")
    .populate<{ userId: { name?: string; email?: string } | null }>("userId", "name email");
  res.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      lastUsedAt: k.lastUsedAt,
      requestCount: k.get("requestCount") ?? 0,
      createdAt: k.get("createdAt"),
      expiresAt: k.get("expiresAt") ?? null,
      createdBy: k.userId ? { name: k.userId.name, email: k.userId.email } : null,
      revealable: Boolean(k.get("keyEnc")),
    })),
  );
});

router.post("/:wid/keys/:kid/reveal", async (req: AuthedRequest, res: Response) => {
  if (req.impersonatorId) return res.status(403).json({ error: "not available while impersonating" });
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const target = await loadRevealTarget(ws.id, String(req.params.kid), String(req.userId));
  if (!target.ok) return res.status(target.status).json({ error: target.error });
  const { key, user } = target;
  if (!hasOwnershipFactor(user)) {
    return res.status(400).json({ error: "set a password or PIN in Security settings to reveal keys" });
  }
  if (await rejectUnconfirmed(user, req.body ?? {}, res)) return;
  const raw = decryptApiKey(key);
  if (!raw) return res.status(409).json({ error: "this key can't be revealed — create a new key instead" });
  await recordAudit(req, {
    action: "api_key.revealed",
    workspaceId: ws.id,
    target: { kind: "api_key", id: key.id, label: key.name as string },
    meta: { prefix: key.prefix as string },
  });
  res.set("Cache-Control", "no-store").json({ id: key.id, key: raw });
});

router.get("/:wid/keys/usage", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const usage = await workspaceKeyUsage(access.workspace.id, parseUsageWindow(req.query.days));
  res.json(usage);
});

router.patch("/:wid/keys/:kid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  const key = await ApiKey.findOneAndUpdate(
    { _id: req.params.kid, workspaceId: access.workspace.id, revoked: false },
    { name },
    { new: true },
  );
  if (!key) return res.status(404).json({ error: "key not found" });
  await recordAudit(req, {
    action: "api_key.updated",
    workspaceId: access.workspace.id,
    target: { kind: "api_key", id: key.id, label: name },
    meta: { prefix: key.prefix as string },
  });
  res.json({ id: key.id, name: key.name });
});

// Revoke a key
router.delete("/:wid/keys/:kid", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "admin");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });
  const ws = access.workspace;
  const key = await ApiKey.findOne({ _id: req.params.kid, workspaceId: ws.id });
  if (!key) return res.status(404).json({ error: "key not found" });
  key.set("revoked", true);
  await Promise.all([
    key.save(),
    recordAudit(req, {
      action: "api_key.revoked",
      workspaceId: ws.id,
      target: { kind: "api_key", id: key.id, label: key.name as string },
      meta: { prefix: key.prefix as string },
    }),
  ]);
  res.status(204).end();
});

export default router;
