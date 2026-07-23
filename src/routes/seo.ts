import { Router, Response } from "express";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { SeoReport } from "../models/SeoReport.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import { analyzeUrl, normalizeUrl, urlMatchesDomain } from "../seo-core.js";
import { rateLimit, BlockedUrlError } from "../lib/safe-fetch.js";
import { Competitor } from "../models/Competitor.js";
import { snapshotPage } from "../lib/compare.js";
import { computeSearchTraffic } from "../lib/search-traffic.js";
import { computeFieldVitals } from "../lib/field-vitals.js";
import { crawlSite } from "../lib/crawl.js";
import { CrawlReport } from "../models/CrawlReport.js";
import { TRACKER_VERSION } from "../stats-core.js";

/**
 * SEO auditing for the sites a workspace already tracks.
 *
 * Deliberately not an open URL scanner: every analysis is anchored to a Site
 * the caller owns, and the URL must live on that site's domain. A signed-in
 * user cannot point this at somebody else's server and have us fetch it for
 * them.
 *
 * Mounted on the same `/api/workspaces` prefix as the workspace routes.
 */
const router = Router();
router.use(requireAuth);

/** How long a stored report is served instead of re-running the audit. */
const FRESH_MS = 60 * 60 * 1000; // 1 hour

/** One analysis at a time per site — PageSpeed is slow and quota-limited. */
const running = new Set<string>();

async function resolveSite(req: AuthedRequest) {
  const ws = await Workspace.findOne({ _id: req.params.wid, userId: req.userId });
  if (!ws) return { error: "workspace not found" as const };
  const site = await Site.findOne({ siteId: req.params.siteId, workspaceId: ws.id });
  if (!site) return { error: "site not found" as const };
  return { ws, site };
}

/**
 * Run (or reuse) an audit for a URL on this site.
 *
 * `?refresh=1` forces a fresh run, which is what the Re-run button sends.
 */
router.post(
  "/:wid/sites/:siteId/seo/analyze",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });
    const { ws, site } = found;

    // Default to the site's own root when no path is given.
    const requested = String(req.body?.url ?? "").trim() || site.domain;
    const url = normalizeUrl(requested);
    if (!url) return res.status(400).json({ error: "invalid URL" });

    if (!urlMatchesDomain(url, site.domain))
      return res.status(400).json({
        error: `URL must be on ${site.domain}`,
      });

    const force = req.query.refresh === "1" || req.query.refresh === "true";

    if (!force) {
      const cached = await SeoReport.findOne({ siteId: site.siteId, url }).sort({
        createdAt: -1,
      });
      if (cached && Date.now() - cached.createdAt.getTime() < FRESH_MS) {
        return res.json({ report: cached, cached: true });
      }
    }

    // Every audit makes the server fetch a URL on the caller's behalf, so the
    // workspace pays for it against a budget rather than being able to drive
    // unbounded outbound traffic.
    const budget = rateLimit(`seo:${ws.id}`, { capacity: 20, refillPerMinute: 10 });
    if (!budget.allowed)
      return res.status(429).json({
        error: `too many audits — try again in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      });

    const lockKey = `${site.siteId}:${url}`;
    if (running.has(lockKey))
      return res.status(429).json({ error: "an analysis for this URL is already running" });
    running.add(lockKey);

    try {
      const data = await analyzeUrl(url);
      const report = await SeoReport.create({
        workspaceId: ws.id,
        siteId: site.siteId,
        userId: req.userId,
        url,
        score: data.score,
        scores: data.performance.scores,
        issueCount: data.issues.length,
        criticalCount: data.issues.filter((i) => i.severity === "critical").length,
        data,
      });
      res.json({ report, cached: false });
    } catch (e) {
      const message = (e as Error)?.message ?? "analysis failed";
      console.error("SEO analysis failed:", site.siteId, url, message);
      // A refused address is a bad request, not an upstream failure: the URL
      // resolved somewhere we will not fetch, and no retry will change that.
      if (e instanceof BlockedUrlError)
        return res.status(400).json({ error: `cannot audit ${url}: ${message}` });
      // The URL being unreachable is the caller's problem to fix, not a server
      // fault — say what happened rather than returning a bare 500.
      res.status(502).json({ error: `could not analyse ${url}: ${message}` });
    } finally {
      running.delete(lockKey);
    }
  }
);

/** Report history for a site, newest first. Bodies are omitted — see below. */
router.get(
  "/:wid/sites/:siteId/seo/reports",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    // A full report is tens of kilobytes; the history list only renders the
    // summary fields, so leave `data` out of the query entirely.
    const reports = await SeoReport.find({ siteId: found.site.siteId })
      .select("-data")
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json(reports);
  }
);

/** The newest report for a site, if one exists. Used to populate the page. */
router.get(
  "/:wid/sites/:siteId/seo/latest",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const url = req.query.url ? normalizeUrl(String(req.query.url)) : null;
    const report = await SeoReport.findOne({
      siteId: found.site.siteId,
      ...(url ? { url } : {}),
    }).sort({ createdAt: -1 });

    if (!report) return res.status(404).json({ error: "no report yet" });
    res.json(report);
  }
);

/** One stored report in full. */
router.get(
  "/:wid/sites/:siteId/seo/reports/:id",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const report = await SeoReport.findOne({
      _id: req.params.id,
      siteId: found.site.siteId,
    });
    if (!report) return res.status(404).json({ error: "report not found" });
    res.json(report);
  }
);

router.delete(
  "/:wid/sites/:siteId/seo/reports/:id",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const deleted = await SeoReport.findOneAndDelete({
      _id: req.params.id,
      siteId: found.site.siteId,
    });
    if (!deleted) return res.status(404).json({ error: "report not found" });
    res.status(204).end();
  }
);

/**
 * Organic search arrivals for this site.
 *
 * Reads the analytics already collected rather than calling any external API,
 * so it costs one database query and needs no OAuth.
 */
router.get(
  "/:wid/sites/:siteId/seo/search-traffic",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const traffic = await computeSearchTraffic([found.site.siteId], since);
    res.json({ ...traffic, days });
  }
);

/**
 * Core Web Vitals measured by real visitors (tracker v5+).
 *
 * Empty until sites re-copy their snippet, which is expected — the dashboard
 * says so rather than showing zeros.
 */
router.get(
  "/:wid/sites/:siteId/seo/vitals",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const vitals = await computeFieldVitals([found.site.siteId], since);
    res.json({
      ...vitals,
      // Lets the UI distinguish "no visitors yet" from "your tracker is too old
      // to report this", which need different advice.
      trackerVersion: found.site.trackerVersion ?? 1,
      requiredVersion: TRACKER_VERSION,
    });
  }
);

/* ---------------------------------- crawl --------------------------------- */

/** Only one crawl per site at a time — each one is dozens of outbound fetches. */
const crawling = new Set<string>();

router.post(
  "/:wid/sites/:siteId/seo/crawl",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });
    const { ws, site } = found;

    const origin = (() => {
      const normalized = normalizeUrl(site.domain as string);
      try {
        return normalized ? new URL(normalized).origin : null;
      } catch {
        return null;
      }
    })();
    if (!origin) return res.status(400).json({ error: "site has an invalid domain" });

    if (crawling.has(site.siteId))
      return res.status(429).json({ error: "a crawl for this site is already running" });

    // A crawl is up to 30 page fetches plus sitemap discovery, so it costs more
    // of the workspace budget than a single audit.
    const budget = rateLimit(`crawl:${ws.id}`, { capacity: 5, refillPerMinute: 2 });
    if (!budget.allowed)
      return res.status(429).json({
        error: `too many crawls — try again in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      });

    crawling.add(site.siteId);
    try {
      const data = await crawlSite(origin);

      if (data.crawled === 0)
        return res.status(400).json({
          error:
            "No sitemap found, so there was nothing to crawl. Publish a sitemap.xml and reference it from robots.txt.",
        });

      const report = await CrawlReport.create({
        workspaceId: ws.id,
        siteId: site.siteId,
        userId: req.userId,
        origin,
        score: data.score,
        crawled: data.crawled,
        discovered: data.discovered,
        findingCount: data.findings.length,
        criticalCount: data.findings.filter((f) => f.severity === "critical").length,
        data,
      });
      res.json(report);
    } catch (e) {
      const message = (e as Error)?.message ?? "crawl failed";
      console.error("Crawl failed:", site.siteId, message);
      if (e instanceof BlockedUrlError)
        return res.status(400).json({ error: `cannot crawl ${origin}: ${message}` });
      res.status(502).json({ error: `could not crawl ${origin}: ${message}` });
    } finally {
      crawling.delete(site.siteId);
    }
  }
);

/** The newest crawl for a site. */
router.get(
  "/:wid/sites/:siteId/seo/crawl/latest",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const report = await CrawlReport.findOne({ siteId: found.site.siteId }).sort({
      createdAt: -1,
    });
    if (!report) return res.status(404).json({ error: "no crawl yet" });
    res.json(report);
  }
);

/* ------------------------------- competitors ------------------------------ */

/**
 * Competitor comparison.
 *
 * This is the one place the server fetches a host the user simply typed, with
 * no prior relationship to the workspace. Two things make that acceptable:
 * `safeFetch` refuses anything that is not publicly routable, and the rate
 * limit stops the endpoint being used to scan or flood.
 */
const MAX_COMPETITORS = 3;

router.get(
  "/:wid/sites/:siteId/seo/competitors",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const list = await Competitor.find({ siteId: found.site.siteId }).sort({ createdAt: 1 });
    res.json(list);
  }
);

router.post(
  "/:wid/sites/:siteId/seo/competitors",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });
    const { ws, site } = found;

    const url = normalizeUrl(String(req.body?.url ?? ""));
    if (!url) return res.status(400).json({ error: "invalid URL" });

    // Comparing a site against itself is a mistake, not a feature.
    if (urlMatchesDomain(url, site.domain))
      return res.status(400).json({ error: "that URL is on your own site" });

    const count = await Competitor.countDocuments({ siteId: site.siteId });
    if (count >= MAX_COMPETITORS)
      return res
        .status(400)
        .json({ error: `at most ${MAX_COMPETITORS} competitors per site` });

    const budget = rateLimit(`compare:${ws.id}`, { capacity: 10, refillPerMinute: 5 });
    if (!budget.allowed)
      return res.status(429).json({
        error: `too many comparisons — try again in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      });

    let hostname = url;
    try {
      hostname = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* normalizeUrl already validated this; fall back to the raw string */
    }

    try {
      const snapshot = await snapshotPage(url);
      const doc = await Competitor.findOneAndUpdate(
        { siteId: site.siteId, url },
        {
          workspaceId: ws.id,
          siteId: site.siteId,
          url,
          label: String(req.body?.label ?? "").trim() || hostname,
          snapshot,
          lastCheckedAt: new Date(),
          lastError: "",
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      res.status(201).json(doc);
    } catch (e) {
      const message = (e as Error)?.message ?? "could not fetch that URL";
      if (e instanceof BlockedUrlError)
        return res.status(400).json({ error: `cannot audit ${url}: ${message}` });
      res.status(502).json({ error: `could not fetch ${url}: ${message}` });
    }
  }
);

/** Re-fetch one competitor. */
router.post(
  "/:wid/sites/:siteId/seo/competitors/:id/refresh",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const competitor = await Competitor.findOne({
      _id: req.params.id,
      siteId: found.site.siteId,
    });
    if (!competitor) return res.status(404).json({ error: "competitor not found" });

    const budget = rateLimit(`compare:${found.ws.id}`, { capacity: 10, refillPerMinute: 5 });
    if (!budget.allowed)
      return res.status(429).json({
        error: `too many comparisons — try again in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      });

    try {
      competitor.set({
        snapshot: await snapshotPage(competitor.url as string),
        lastCheckedAt: new Date(),
        lastError: "",
      });
      await competitor.save();
      res.json(competitor);
    } catch (e) {
      // A failure is recorded rather than thrown away: "we tried and their site
      // was down" is more useful than a snapshot that silently went stale.
      const message = (e as Error)?.message ?? "could not fetch that URL";
      competitor.set({ lastCheckedAt: new Date(), lastError: message });
      await competitor.save();
      res.status(502).json({ error: message });
    }
  }
);

router.delete(
  "/:wid/sites/:siteId/seo/competitors/:id",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if ("error" in found) return res.status(404).json({ error: found.error });

    const deleted = await Competitor.findOneAndDelete({
      _id: req.params.id,
      siteId: found.site.siteId,
    });
    if (!deleted) return res.status(404).json({ error: "competitor not found" });
    res.status(204).end();
  }
);

export default router;
