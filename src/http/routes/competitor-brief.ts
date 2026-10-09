import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveSite, siteRefused } from "./resolve-site.js";
import { rateLimit } from "../../infra/http-client/safe-fetch.js";
import { competitorAnalysis } from "../../modules/seo/compare-analysis.service.js";
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

    const analysis = await competitorAnalysis(found.site.siteId);
    if (!analysis) return res.status(404).json({ error: "no baseline for your page yet" });

    const entry = analysis.competitors.find((c) => c.competitorId === req.params.competitorId);
    if (!entry) return res.status(404).json({ error: "competitor not found or not fetched yet" });
    if (entry.readIssue)
      return res.status(409).json({ error: "we could not read this competitor's page, so there is nothing reliable to brief on" });

    const result = await generateBrief(
      {
        label: entry.label,
        theirScore: entry.snapshot.score,
        gap: entry.gap,
        snapshot: entry.snapshot,
      },
      analysis.mine.score,
      analysis.position
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
