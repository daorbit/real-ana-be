import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveSite, siteRefused } from "./resolve-site.js";
import { normalizeUrl, urlMatchesDomain } from "../../modules/seo/seo.service.js";
import { rateLimit, BlockedUrlError } from "../../infra/http-client/safe-fetch.js";
import { Competitor } from "../../modules/seo/models/Competitor.js";
import { CompetitorSnapshot } from "../../modules/seo/models/CompetitorSnapshot.js";
import { CompetitorBacklink } from "../../modules/backlinks/models/CompetitorBacklink.js";
import { snapshotPage } from "../../modules/seo/competitor.js";
import { competitorAnalysis } from "../../modules/seo/compare-analysis.service.js";
import { baselineHistory, refreshBaseline } from "../../modules/seo/compare-baseline.service.js";
import { recordSnapshot, refetchCompetitor } from "../../modules/seo/competitor-refresh.service.js";

const BASELINE_ID = "__you__";

/**
 * Competitor tracking.
 *
 * This is the one place the server fetches a host the user simply typed, with
 * no prior relationship to the workspace. Two things make that acceptable:
 * `safeFetch` refuses anything that is not publicly routable, and the rate
 * limit stops the endpoint being used to scan or flood.
 *
 * Split out of `seo.ts` once competitors grew their own page: the routes are
 * scoped to a site like the audit routes, but nothing else is shared, and
 * `seo.ts` was already carrying five unrelated concerns.
 *
 * Mounted on the same `/api/workspaces` prefix as the SEO routes, and keeps
 * the original `/seo/competitors` paths so existing clients are unaffected.
 */
const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

/**
 * Ten rather than the original three.
 *
 * Three fit a tab inside the audit page; a page of its own invites tracking a
 * real competitive set. The ceiling stays low enough that "refresh all" is a
 * bounded amount of outbound traffic to sites that did not ask for it.
 */
const MAX_COMPETITORS = 10;

/**
 * The comparison budget for one workspace.
 *
 * Sized for the higher competitor ceiling: a full refresh of ten is allowed to
 * go through in one burst, and the refill still limits sustained use.
 */
function compareBudget(workspaceId: string) {
  return rateLimit(`compare:${workspaceId}`, { capacity: 25, refillPerMinute: 10 });
}

router.get(
  "/:wid/sites/:siteId/seo/competitors",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const list = await Competitor.find({ siteId: found.site.siteId }).sort({ createdAt: 1 });
    res.json(list);
  }
);

/** Score history for every competitor on this site, oldest first for plotting. */
router.get(
  "/:wid/sites/:siteId/seo/competitors/history",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const [rows, mine] = await Promise.all([
      CompetitorSnapshot.find({ siteId: found.site.siteId })
        .sort({ takenAt: 1 })
        .select("competitorId score wordCount responseTimeMs statusCode takenAt")
        .lean(),
      baselineHistory(found.site.siteId),
    ]);

    res.json([...rows, ...mine.map((p) => ({ ...p, competitorId: BASELINE_ID }))]);
  }
);

/**
 * The full comparison: your latest audit against every tracked competitor,
 * with the gaps and what to do about them already worked out.
 *
 * Computed here rather than in the page so the comparison the UI draws and the
 * one Orbit reasons from are the same computation.
 */
router.get(
  "/:wid/sites/:siteId/seo/competitors/analysis",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const analysis = await competitorAnalysis(found.site.siteId);
    if (!analysis) return res.status(404).json({ error: "no baseline for your page yet" });
    res.json(analysis);
  }
);

router.post(
  "/:wid/sites/:siteId/seo/competitors",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "editor");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });
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

    const budget = compareBudget(ws.id);
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
      const [snapshot] = await Promise.all([snapshotPage(url), refreshBaseline(site)]);
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
          lastErrorAt: null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await recordSnapshot(String(doc._id), site.siteId, snapshot);
      res.status(201).json(doc);
    } catch (e) {
      const message = (e as Error)?.message ?? "could not fetch that URL";
      if (e instanceof BlockedUrlError)
        return res.status(400).json({ error: `cannot audit ${url}: ${message}` });
      res.status(502).json({ error: `could not fetch ${url}: ${message}` });
    }
  }
);

/**
 * Refresh every competitor on the site.
 *
 * Sequential, not parallel: ten simultaneous requests to ten unrelated hosts
 * is a burst that looks like a scan from the receiving end, and the whole set
 * still completes in a few seconds. One failure does not stop the rest — each
 * competitor records its own error exactly as a single refresh would.
 */
router.post(
  "/:wid/sites/:siteId/seo/competitors/refresh-all",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "editor");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const budget = compareBudget(found.ws.id);
    if (!budget.allowed)
      return res.status(429).json({
        error: `too many comparisons — try again in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      });

    const list = await Competitor.find({ siteId: found.site.siteId }).sort({ createdAt: 1 });
    const baseline = refreshBaseline(found.site);

    let refreshed = 0;
    let failed = 0;
    for (const competitor of list) {
      try {
        await refetchCompetitor(competitor, found.site.siteId);
        refreshed++;
      } catch {
        failed++;
      }
    }
    await baseline;

    const fresh = await Competitor.find({ siteId: found.site.siteId }).sort({ createdAt: 1 });
    res.json({ competitors: fresh, refreshed, failed });
  }
);

/** Re-fetch one competitor. */
router.post(
  "/:wid/sites/:siteId/seo/competitors/:id/refresh",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "editor");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const competitor = await Competitor.findOne({
      _id: req.params.id,
      siteId: found.site.siteId,
    });
    if (!competitor) return res.status(404).json({ error: "competitor not found" });

    const budget = compareBudget(found.ws.id);
    if (!budget.allowed)
      return res.status(429).json({
        error: `too many comparisons — try again in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      });

    try {
      await Promise.all([refetchCompetitor(competitor, found.site.siteId), refreshBaseline(found.site)]);
      res.json(competitor);
    } catch (e) {
      res.status(502).json({ error: (e as Error)?.message ?? "could not fetch that URL" });
    }
  }
);

router.delete(
  "/:wid/sites/:siteId/seo/competitors/:id",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "editor");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const deleted = await Competitor.findOneAndDelete({
      _id: req.params.id,
      siteId: found.site.siteId,
    });
    if (!deleted) return res.status(404).json({ error: "competitor not found" });

    // The trend rows are meaningless once the competitor is gone, and leaving
    // them would let a re-added URL inherit a stranger's history.
    await CompetitorSnapshot.deleteMany({ competitorId: deleted._id });
    await CompetitorBacklink.deleteMany({ competitorId: deleted._id });

    res.status(204).end();
  }
);

export default router;
