import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveSite, siteRefused } from "./resolve-site.js";
import { rateLimit } from "../../infra/http-client/safe-fetch.js";
import { Competitor } from "../../modules/seo/models/Competitor.js";
import { SeoReport } from "../../modules/seo/models/SeoReport.js";
import { snapshotFromReport, type CompareSnapshot } from "../../modules/seo/competitor.js";
import { compareSnapshots, computePosition } from "../../modules/seo/competitor-analysis.js";
import { briefingAvailable, generateBrief } from "../../modules/seo/competitor-brief.js";

/**
 * The AI reading of one competitor comparison.
 *
 * Its own route module rather than another handler in `competitors.ts`, because
 * it is the only competitor endpoint that costs money per call, needs its own
 * rate limit, and can be switched off entirely by leaving the Cloudflare
 * credentials unset. Bundling that with the CRUD would put a paid, throttled,
 * optionally-absent operation behind the same door as `GET /competitors`.
 *
 * Generated on request rather than alongside the analysis: the analysis is
 * fetched on every page load and a model call on each would be slow and
 * expensive for a panel most visits never scroll to.
 */
const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

/**
 * Six briefings a minute per workspace.
 *
 * A workspace tracking the ceiling of ten competitors can brief the whole set
 * inside two minutes, which is faster than anyone reads them, while a loop
 * hitting the endpoint cannot run up a bill.
 */
const BRIEF_LIMIT = { capacity: 6, refillPerMinute: 6 };

/** Whether the panel should render at all. Cheap, and never rate-limited. */
router.get(
  "/:wid/sites/:siteId/seo/competitors/brief/availability",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    res.json({ available: briefingAvailable() });
  }
);

/**
 * The briefing for one competitor.
 *
 * POST rather than GET despite reading no state: it costs a model call, and a
 * GET invites a proxy or a prefetching browser to spend that budget without the
 * user ever having asked for it.
 */
router.post(
  "/:wid/sites/:siteId/seo/competitors/:competitorId/brief",
  async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    // 503 rather than 404: the endpoint exists and the deployment simply has no
    // credentials, which is a thing an operator fixes rather than a bad URL.
    if (!briefingAvailable())
      return res.status(503).json({ error: "AI briefing is not configured on this deployment" });

    const limit = rateLimit(`brief:${found.ws.id}`, BRIEF_LIMIT);
    if (!limit.allowed) {
      res.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
      return res.status(429).json({ error: "Too many briefings. Try again shortly." });
    }

    const report = await SeoReport.findOne({ siteId: found.site.siteId }).sort({ createdAt: -1 });
    if (!report?.get("data"))
      return res.status(404).json({ error: "run an audit on your own site first" });

    const competitor = await Competitor.findOne({
      _id: req.params.competitorId,
      siteId: found.site.siteId,
    });
    if (!competitor) return res.status(404).json({ error: "competitor not found" });

    const theirSnapshot = competitor.get("snapshot") as CompareSnapshot | null;
    if (!theirSnapshot)
      return res.status(409).json({ error: "this competitor has not been fetched yet" });

    const mine = snapshotFromReport(
      report.get("data") as Parameters<typeof snapshotFromReport>[0]
    );
    const gap = compareSnapshots(mine, theirSnapshot);

    // The standings are recomputed here rather than passed in from the client,
    // so the brief cannot be steered by a caller claiming a rank it does not
    // hold. Costs one extra query and removes the whole class of problem.
    const siblings = await Competitor.find({ siteId: found.site.siteId });
    const position = computePosition(
      mine.score,
      siblings
        .filter((c) => c.get("snapshot"))
        .map((c) => ({
          competitorId: String(c._id),
          label: c.get("label") as string,
          snapshot: c.get("snapshot") as CompareSnapshot,
        }))
    );

    const result = await generateBrief(
      {
        label: competitor.get("label") as string,
        theirScore: theirSnapshot.score,
        gap,
        snapshot: theirSnapshot,
      },
      mine.score,
      position
    );

    // 502 rather than 500: the failure is upstream at the model provider, and
    // the client's correct response is to offer a retry rather than report a bug.
    if (!result.ok) return res.status(502).json({ error: result.reason });

    res.json({
      brief: result.brief,
      model: result.model,
      generatedAt: new Date().toISOString(),
    });
  }
);

export default router;
