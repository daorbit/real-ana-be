import { Router, Response } from "express";
import { Event } from "../models/Event.js";
import { Site } from "../models/Site.js";
import { requireAuth, AuthedRequest } from "../auth.js";

const router = Router();
router.use(requireAuth);

const RANGES: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// Verify the requesting user owns the site
async function ownedSite(userId: string, siteId: string) {
  return Site.findOne({ siteId, userId });
}

async function topBy(siteId: string, since: Date, field: string, limit = 8) {
  return Event.aggregate([
    { $match: { siteId, ts: { $gte: since } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ]);
}

// Full stats bundle
router.get("/:siteId/stats", async (req: AuthedRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.userId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });

  const rangeKey = String(req.query.range ?? "24h");
  const windowMs = RANGES[rangeKey] ?? RANGES["24h"];
  const since = new Date(Date.now() - windowMs);
  const liveSince = new Date(Date.now() - 5 * 60 * 1000);

  const [
    pageviews,
    visitorsAgg,
    live,
    topPages,
    topReferrers,
    devices,
    countries,
    utmSources,
    timeseries,
  ] = await Promise.all([
    Event.countDocuments({ siteId, type: "pageview", ts: { $gte: since } }),
    Event.distinct("visitorHash", { siteId, ts: { $gte: since } }),
    Event.distinct("visitorHash", { siteId, ts: { $gte: liveSince } }),
    topBy(siteId, since, "path"),
    topBy(siteId, since, "referrer"),
    topBy(siteId, since, "device"),
    topBy(siteId, since, "country"),
    topBy(siteId, since, "utm.source"),
    Event.aggregate([
      { $match: { siteId, ts: { $gte: since } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: windowMs <= RANGES["24h"] ? "%Y-%m-%dT%H:00" : "%Y-%m-%d",
              date: "$ts",
            },
          },
          views: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, bucket: "$_id", views: 1 } },
    ]),
  ]);

  res.json({
    range: rangeKey,
    pageviews,
    visitors: visitorsAgg.length,
    live: live.length,
    topPages,
    topReferrers: topReferrers.map((r) => ({ ...r, key: r.key || "(direct)" })),
    devices,
    countries,
    utmSources: utmSources.map((r) => ({ ...r, key: r.key || "(none)" })),
    timeseries,
  });
});

// Lightweight live count for frequent polling
router.get("/:siteId/live", async (req: AuthedRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await ownedSite(req.userId!, siteId);
  if (!site) return res.status(404).json({ error: "site not found" });
  const liveSince = new Date(Date.now() - 5 * 60 * 1000);
  const live = await Event.distinct("visitorHash", { siteId, ts: { $gte: liveSince } });
  res.json({ live: live.length });
});

export default router;
