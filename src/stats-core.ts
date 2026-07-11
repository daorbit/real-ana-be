import { Event } from "./models/Event.js";

export const RANGES: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const LIVE_WINDOW_MS = 5 * 60 * 1000;

type Match = Record<string, unknown>;

async function topBy(match: Match, field: string, limit = 8) {
  return Event.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ]);
}

/** Headline counters for one window — used for both the current and previous period. */
async function totals(siteIds: string[], from: Date, to: Date) {
  const inSites = { $in: siteIds };
  const window = { siteId: inSites, ts: { $gte: from, $lt: to } };

  const [pageviews, visitors, sessions, engagement] = await Promise.all([
    Event.countDocuments({ ...window, type: "pageview" }),
    Event.distinct("visitorHash", window),
    Event.distinct("sessionId", window),
    Event.aggregate([
      { $match: { ...window, type: "engagement" } },
      {
        $group: {
          _id: null,
          totalMs: { $sum: "$durationMs" },
          samples: { $sum: 1 },
          // one bounce record is emitted per session that ended with a single view
          bounces: { $sum: { $cond: ["$bounce", 1, 0] } },
          exits: { $sum: { $cond: ["$isExit", 1, 0] } },
        },
      },
    ]),
  ]);

  const e = engagement[0] ?? { totalMs: 0, samples: 0, bounces: 0, exits: 0 };
  const sessionCount = sessions.length;

  return {
    pageviews,
    visitors: visitors.length,
    sessions: sessionCount,
    // avg visible time on a single page
    avgTimeOnPageMs: e.samples > 0 ? Math.round(e.totalMs / e.samples) : 0,
    // avg total visible time across a session
    avgSessionMs: sessionCount > 0 ? Math.round(e.totalMs / sessionCount) : 0,
    // share of sessions that ended after a single pageview
    bounceRate: e.exits > 0 ? Math.round((e.bounces / e.exits) * 100) : 0,
    pagesPerSession:
      sessionCount > 0 ? Math.round((pageviews / sessionCount) * 10) / 10 : 0,
  };
}

/** Percentage change vs. the previous equal-length period. null when there is no baseline. */
function delta(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Bucket a screen width into a readable label. */
const SCREEN_BUCKETS = [
  { max: 575, key: "Mobile (<576px)" },
  { max: 767, key: "Large mobile (576–767px)" },
  { max: 991, key: "Tablet (768–991px)" },
  { max: 1439, key: "Laptop (992–1439px)" },
  { max: Infinity, key: "Desktop (1440px+)" },
];

async function screenSizes(match: Match) {
  const rows = await Event.aggregate([
    { $match: { ...match, viewportW: { $gt: 0 } } },
    { $group: { _id: "$viewportW", count: { $sum: 1 } } },
  ]);
  const buckets = new Map<string, number>();
  for (const r of rows as { _id: number; count: number }[]) {
    const b = SCREEN_BUCKETS.find((s) => r._id <= s.max)!;
    buckets.set(b.key, (buckets.get(b.key) ?? 0) + r.count);
  }
  return [...buckets.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/** Who is on the site right now, and what page are they looking at. */
async function livePages(siteIds: string[]) {
  const since = new Date(Date.now() - LIVE_WINDOW_MS);
  const rows = await Event.aggregate([
    { $match: { siteId: { $in: siteIds }, type: "pageview", ts: { $gte: since } } },
    { $sort: { ts: -1 } },
    // the page each live visitor most recently landed on
    { $group: { _id: "$visitorHash", path: { $first: "$path" } } },
    { $group: { _id: "$path", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 8 },
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ]);
  return rows;
}

export async function computeStats(siteIds: string[], rangeKey: string) {
  const windowMs = RANGES[rangeKey] ?? RANGES["24h"];
  const now = Date.now();
  const since = new Date(now - windowMs);
  const prevSince = new Date(now - windowMs * 2);
  const liveSince = new Date(now - LIVE_WINDOW_MS);

  const inSites = { $in: siteIds };
  const base: Match = { siteId: inSites, ts: { $gte: since } };
  const pageviewBase: Match = { ...base, type: "pageview" };

  const [
    current,
    previous,
    live,
    topPages,
    entryPages,
    exitPages,
    topReferrers,
    devices,
    browsers,
    operatingSystems,
    countries,
    languages,
    screens,
    utmSources,
    utmCampaigns,
    timeseries,
    liveNow,
  ] = await Promise.all([
    totals(siteIds, since, new Date(now)),
    totals(siteIds, prevSince, since),
    Event.distinct("visitorHash", { siteId: inSites, ts: { $gte: liveSince } }),
    topBy(pageviewBase, "path"),
    topBy({ ...pageviewBase, isEntry: true }, "path"),
    topBy({ ...base, type: "engagement", isExit: true }, "path"),
    topBy(base, "referrer"),
    topBy(pageviewBase, "device"),
    topBy(pageviewBase, "browser"),
    topBy(pageviewBase, "os"),
    topBy(pageviewBase, "country"),
    topBy(pageviewBase, "language"),
    screenSizes(pageviewBase),
    topBy(base, "utm.source"),
    topBy(base, "utm.campaign"),
    Event.aggregate([
      { $match: pageviewBase },
      {
        $group: {
          _id: {
            $dateToString: {
              format: windowMs <= RANGES["24h"] ? "%H:00" : "%m-%d",
              date: "$ts",
            },
          },
          views: { $sum: 1 },
          visitors: { $addToSet: "$visitorHash" },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          bucket: "$_id",
          views: 1,
          visitors: { $size: "$visitors" },
        },
      },
    ]),
    livePages(siteIds),
  ]);

  const clean = (rows: { key: string; count: number }[], fallback: string) =>
    rows.map((r) => ({ ...r, key: r.key || fallback }));

  return {
    range: rangeKey,

    // headline numbers
    pageviews: current.pageviews,
    visitors: current.visitors,
    sessions: current.sessions,
    live: live.length,

    // engagement
    bounceRate: current.bounceRate,
    avgSessionMs: current.avgSessionMs,
    avgTimeOnPageMs: current.avgTimeOnPageMs,
    pagesPerSession: current.pagesPerSession,

    // change vs. the previous equal-length period
    deltas: {
      pageviews: delta(current.pageviews, previous.pageviews),
      visitors: delta(current.visitors, previous.visitors),
      sessions: delta(current.sessions, previous.sessions),
      bounceRate: delta(current.bounceRate, previous.bounceRate),
      avgSessionMs: delta(current.avgSessionMs, previous.avgSessionMs),
      pagesPerSession: delta(current.pagesPerSession, previous.pagesPerSession),
    },

    // breakdowns
    topPages,
    entryPages,
    exitPages,
    topReferrers: clean(topReferrers, "(direct)"),
    devices,
    browsers,
    operatingSystems,
    countries,
    languages: clean(languages, "(unknown)"),
    screenSizes: screens,
    utmSources: clean(utmSources, "(none)"),
    utmCampaigns: clean(utmCampaigns, "(none)"),

    // real-time
    livePages: liveNow,

    timeseries,
  };
}
