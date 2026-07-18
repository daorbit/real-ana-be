import { Router, Request, Response } from "express";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { computeStats, resolveWindow } from "../stats-core.js";

/**
 * Public, unauthenticated read-only dashboards.
 *
 * The share token is the entire credential, so this router is deliberately
 * narrow: one route, no parameters beyond a range, and a response that is
 * built field by field rather than spread from the stats object. Anything not
 * listed here cannot leak, even if `computeStats` grows new fields later.
 *
 * Never exposed: site ids (they are the public tracking keys — leaking one
 * lets anyone post events into the customer's analytics), workspace id, owner
 * identity, raw events, or per-site breakdowns.
 */
const router = Router();

/** Ranges a public viewer may request. Anything else falls back to 30 days. */
const PUBLIC_RANGES = new Set(["24h", "7d", "30d"]);

router.get("/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  // Cheap shape check before touching the database, so a flood of junk tokens
  // costs nothing to reject.
  if (!token.startsWith("pk_") || token.length > 64) {
    return res.status(404).json({ error: "not found" });
  }

  const ws = await Workspace.findOne({ shareToken: token, shareEnabled: true })
    .select("name createdAt sharePanels");
  // A disabled or unknown token gets the same 404 — distinguishing them would
  // confirm that a token exists, which is information a guesser can use.
  if (!ws) return res.status(404).json({ error: "not found" });

  // Count the open. Fire-and-forget: a failed counter must never stop the
  // dashboard rendering, and the owner cares about the trend, not exactness.
  // Only the first page load counts — range switches re-fetch, and counting
  // those would turn one visitor idly clicking tabs into four "views".
  if (req.query.count === "1") {
    Workspace.updateOne(
      { _id: ws.id },
      { $inc: { shareViews: 1 }, $set: { shareLastViewedAt: new Date() } },
    ).catch(() => {});
  }

  const sites = await Site.find({ workspaceId: ws.id }).select("siteId");
  const siteIds = sites.map((s) => s.siteId as string);

  const rangeKey = PUBLIC_RANGES.has(String(req.query.range))
    ? String(req.query.range)
    : "30d";

  // Panels the owner turned off are omitted from the response entirely rather
  // than hidden by the client — data that never leaves the server cannot be
  // read out of the network tab.
  const raw = (ws.get("sharePanels") ?? {}) as Record<string, unknown>;
  const on = (key: string) => raw[key] === undefined || Boolean(raw[key]);

  const panels = {
    totals: on("totals"),
    trend: on("trend"),
    pages: on("pages"),
    sources: on("sources"),
    countries: on("countries"),
    devices: on("devices"),
  };

  if (siteIds.length === 0) {
    return res.json({
      workspace: ws.get("name"),
      range: rangeKey,
      panels,
      pageviews: 0,
      visitors: 0,
      live: 0,
      topPages: [],
      topReferrers: [],
      countries: [],
      devices: [],
      timeseries: [],
    });
  }

  const win = resolveWindow(rangeKey);
  const stats = await computeStats(siteIds, rangeKey, {}, win);

  // Explicit allowlist — not a spread. Adding a field to the dashboard's stats
  // must never silently publish it here.
  res.json({
    workspace: ws.get("name"),
    range: rangeKey,
    panels,
    pageviews: panels.totals ? stats.pageviews : 0,
    visitors: panels.totals ? stats.visitors : 0,
    live: panels.totals ? stats.live : 0,
    topPages: panels.pages ? stats.topPages : [],
    topReferrers: panels.sources ? stats.topReferrers : [],
    countries: panels.countries ? stats.countries : [],
    devices: panels.devices ? stats.devices : [],
    timeseries: panels.trend ? stats.timeseries : [],
  });
});

export default router;
