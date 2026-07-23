import { Router, Response } from "express";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { SeoReport } from "../models/SeoReport.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import { analyzeUrl, normalizeUrl, urlMatchesDomain } from "../seo-core.js";

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

export default router;
