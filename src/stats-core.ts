import { Event } from "./models/Event.js";

export const RANGES: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

async function topBy(match: object, field: string, limit = 8) {
  return Event.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ]);
}

// Compute the full stats bundle for one or more sites.
export async function computeStats(siteIds: string[], rangeKey: string) {
  const windowMs = RANGES[rangeKey] ?? RANGES["24h"];
  const since = new Date(Date.now() - windowMs);
  const liveSince = new Date(Date.now() - 5 * 60 * 1000);
  const inSites = { $in: siteIds };
  const base = { siteId: inSites, ts: { $gte: since } };

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
    Event.countDocuments({ siteId: inSites, type: "pageview", ts: { $gte: since } }),
    Event.distinct("visitorHash", base),
    Event.distinct("visitorHash", { siteId: inSites, ts: { $gte: liveSince } }),
    topBy(base, "path"),
    topBy(base, "referrer"),
    topBy(base, "device"),
    topBy(base, "country"),
    topBy(base, "utm.source"),
    Event.aggregate([
      { $match: base },
      {
        $group: {
          _id: {
            $dateToString: {
              format: windowMs <= RANGES["24h"] ? "%H:00" : "%m-%d",
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

  return {
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
  };
}
