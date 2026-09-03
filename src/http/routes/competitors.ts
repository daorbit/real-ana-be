import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveSite, siteRefused } from "./resolve-site.js";
import { normalizeUrl, urlMatchesDomain } from "../../modules/seo/seo.service.js";
import { rateLimit, BlockedUrlError } from "../../infra/http-client/safe-fetch.js";
import { Competitor } from "../../modules/seo/models/Competitor.js";
import { CompetitorSnapshot } from "../../modules/seo/models/CompetitorSnapshot.js";
import {
  snapshotPage, snapshotFromReport, type CompareSnapshot,
} from "../../modules/seo/competitor.js";
import { compareSnapshots, computePosition } from "../../modules/seo/competitor-analysis.js";
import { SeoReport } from "../../modules/seo/models/SeoReport.js";

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

/** Snapshots kept per competitor. Roughly a year of weekly refreshes. */
const MAX_HISTORY = 60;

/**
 * The comparison budget for one workspace.
 *
 * Sized for the higher competitor ceiling: a full refresh of ten is allowed to
 * go through in one burst, and the refill still limits sustained use.
 */
function compareBudget(workspaceId: string) {
  return rateLimit(`compare:${workspaceId}`, { capacity: 25, refillPerMinute: 10 });
}

/**
 * Record a snapshot in the trend history.
 *
 * Only the numbers a trend line is drawn from — the full snapshot already
 * lives on the parent document, and storing every past copy of someone else's
 * page would be storage spent on a question nobody asks.
 *
 * Failures are swallowed: a comparison that worked must not 500 because its
 * history row did not write.
 */
async function recordSnapshot(
  competitorId: string,
  siteId: string,
  snapshot: CompareSnapshot
): Promise<void> {
  try {
    await CompetitorSnapshot.create({
      competitorId,
      siteId,
      score: snapshot.score,
      wordCount: snapshot.wordCount,
      responseTimeMs: snapshot.responseTimeMs,
      pageBytes: snapshot.pageBytes,
      internalLinks: snapshot.internalLinks,
      schemaErrors: snapshot.schemaErrors,
      statusCode: snapshot.statusCode,
    });

    // Trimmed here rather than by a TTL index: the useful window is "the last
    // N runs", which is a count, and a site refreshed daily and one refreshed
    // yearly should both keep a readable trend.
    const stale = await CompetitorSnapshot.find({ competitorId })
      .sort({ takenAt: -1 })
      .skip(MAX_HISTORY)
      .select("_id");
    if (stale.length) {
      await CompetitorSnapshot.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
    }
  } catch {
    /* history is best-effort; the comparison itself already succeeded */
  }
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

    const rows = await CompetitorSnapshot.find({ siteId: found.site.siteId })
      .sort({ takenAt: 1 })
      .select("competitorId score wordCount responseTimeMs statusCode takenAt")
      .lean();

    res.json(rows);
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

    const report = await SeoReport.findOne({ siteId: found.site.siteId }).sort({
      createdAt: -1,
    });
    // Without an audit of your own there is no baseline, and a comparison of
    // competitors against each other is not what this answers.
    if (!report?.get("data"))
      return res.status(404).json({ error: "run an audit on your own site first" });

    const mine = snapshotFromReport(report.get("data") as Parameters<typeof snapshotFromReport>[0]);
    const competitors = await Competitor.find({ siteId: found.site.siteId }).sort({
      createdAt: 1,
    });

    const comparisons = competitors
      .filter((c) => c.get("snapshot"))
      .map((c) => ({
        competitorId: String(c._id),
        label: c.get("label") as string,
        url: c.get("url") as string,
        lastCheckedAt: c.get("lastCheckedAt") as Date | null,
        snapshot: c.get("snapshot") as CompareSnapshot,
        gap: compareSnapshots(mine, c.get("snapshot") as CompareSnapshot),
      }));

    res.json({
      mine,
      auditedAt: report.get("createdAt"),
      competitors: comparisons,
      // Ranked so the page can lead with whoever is furthest ahead — that is
      // the one worth reading first.
      toughest: [...comparisons].sort((a, b) => b.gap.scoreGap - a.gap.scoreGap)[0]?.competitorId ?? null,
      // Where you sit in the field as a whole. A per-competitor delta cannot
      // answer "am I winning overall", which is the first thing anyone tracking
      // more than one rival wants to know.
      position: computePosition(mine.score, comparisons),
    });
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

    let refreshed = 0;
    let failed = 0;
    for (const competitor of list) {
      try {
        const snapshot = await snapshotPage(competitor.url as string);
        competitor.set({ snapshot, lastCheckedAt: new Date(), lastError: "" });
        await competitor.save();
        await recordSnapshot(String(competitor._id), found.site.siteId, snapshot);
        refreshed++;
      } catch (e) {
        const message = (e as Error)?.message ?? "could not fetch that URL";
        competitor.set({ lastCheckedAt: new Date(), lastError: message });
        await competitor.save();
        failed++;
      }
    }

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
      const snapshot = await snapshotPage(competitor.url as string);
      competitor.set({ snapshot, lastCheckedAt: new Date(), lastError: "" });
      await competitor.save();
      await recordSnapshot(String(competitor._id), found.site.siteId, snapshot);
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

    res.status(204).end();
  }
);

export default router;
