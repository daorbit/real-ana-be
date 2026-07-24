import { Router, Request, Response } from "express";
import { SeoReport } from "../models/SeoReport.js";
import { readSeoPanels } from "./seo.js";

/**
 * Public, unauthenticated read-only SEO audit reports.
 *
 * The share token is the entire credential, so this router is deliberately
 * narrow: one route, and a response assembled field by field rather than
 * spread from the stored report. A section the owner did not publish is dropped
 * here, on the server — it never reaches the network at all.
 *
 * Never exposed: the site id (it is the public tracking key — leaking one lets
 * anyone post events into the customer's analytics), workspace id, owner
 * identity, or any report the owner has not explicitly shared.
 */
const router = Router();

router.get("/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  // Cheap shape check before touching the database, so a flood of junk tokens
  // costs nothing to reject.
  if (!token.startsWith("pk_seo_") || token.length > 80) {
    return res.status(404).json({ error: "not found" });
  }

  const report = await SeoReport.findOne({ shareToken: token, shareEnabled: true });
  // A disabled or unknown token gets the same 404 — distinguishing them would
  // confirm a token exists, which a guesser can use.
  if (!report) return res.status(404).json({ error: "not found" });

  // Count the open, fire-and-forget: a failed counter must never stop the page
  // rendering. Only the first load counts — panel/range switches re-fetch, and
  // counting those turns one reader into several "views".
  if (req.query.count === "1") {
    SeoReport.updateOne(
      { _id: report.id },
      { $inc: { shareViews: 1 }, $set: { shareLastViewedAt: new Date() } }
    ).catch(() => {});
  }

  const panels = readSeoPanels(report.get("sharePanels"));
  const data = (report.get("data") ?? {}) as Record<string, any>;

  // Explicit allowlist keyed on the owner's panel choices. A section that is
  // off is emitted as null/empty, never as the underlying data.
  res.json({
    url: report.get("url"),
    finalUrl: data.finalUrl ?? report.get("url"),
    score: report.get("score") ?? 0,
    createdAt: report.get("createdAt"),
    panels,

    performance: panels.summary || panels.performance
      ? sharePerformance(data.performance, panels)
      : null,

    issues: panels.issues ? data.issues ?? [] : [],

    meta: panels.meta ? data.meta ?? null : null,
    content: panels.content ? data.content ?? null : null,
    technical: panels.technical ? data.technical ?? null : null,
    siteFiles: panels.technical ? data.siteFiles ?? null : null,
    links: panels.links ? data.links ?? null : null,
    schema: panels.schema ? data.schema ?? null : null,
  });
});

/**
 * Performance is used by two panels: the summary band (just the category
 * scores) and the full performance section (metrics + suggestions). Send only
 * what the enabled panels justify.
 */
function sharePerformance(
  perf: Record<string, any> | undefined,
  panels: Record<string, boolean>
) {
  if (!perf) return null;
  const base = {
    available: Boolean(perf.available),
    scores: perf.scores ?? {
      seo: null,
      performance: null,
      accessibility: null,
      bestPractices: null,
    },
  };
  if (!panels.performance) {
    // Summary only: category rings, no metrics or opportunity list.
    return { ...base, mobile: null, desktop: null, suggestions: [] };
  }
  return {
    ...base,
    mobile: perf.mobile ?? null,
    desktop: perf.desktop ?? null,
    suggestions: perf.suggestions ?? [],
  };
}

export default router;
