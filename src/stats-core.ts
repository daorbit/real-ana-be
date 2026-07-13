import { Event } from "./models/Event.js";

/**
 * Current tracker.js version. Sites reporting less than this are missing the
 * data the newer metrics need — keep in step with `VERSION` in public/tracker.js.
 */
export const TRACKER_VERSION = 2;

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

/**
 * Which CTAs were clicked, and on which page. We group by the label + the page
 * it was clicked from, so the same button on two pages shows as two rows.
 */
async function topClicks(match: Match, limit = 10) {
  return Event.aggregate([
    { $match: { ...match, type: "click" } },
    {
      $group: {
        _id: {
          // prefer an explicit data-va-cta / id, fall back to the visible text
          label: { $cond: [{ $ne: ["$clickId", ""] }, "$clickId", "$clickText"] },
          path: "$path",
        },
        count: { $sum: 1 },
        href: { $first: "$clickHref" },
        tag: { $first: "$clickTag" },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        key: "$_id.label",
        path: "$_id.path",
        href: 1,
        tag: 1,
        count: 1,
      },
    },
  ]);
}

/**
 * How far down each page people actually get.
 *
 * Averaged per path from the engagement records, which carry the furthest point
 * reached. Pages nobody scrolled on are excluded rather than counted as zero —
 * a page with no engagement record has no depth, which is not the same as a
 * page people abandoned at the top.
 */
async function scrollDepth(match: Match, limit = 10) {
  return Event.aggregate([
    { $match: { ...match, type: "engagement", scrollDepth: { $gt: 0 } } },
    {
      $group: {
        _id: "$path",
        avgDepth: { $avg: "$scrollDepth" },
        // Reaching the bottom is the outcome people actually care about.
        reachedEnd: { $sum: { $cond: [{ $gte: ["$scrollDepth", 90] }, 1, 0] } },
        samples: { $sum: 1 },
      },
    },
    { $sort: { samples: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        key: "$_id",
        count: "$samples",
        avgDepth: { $round: ["$avgDepth", 0] },
        completionRate: {
          $round: [{ $multiply: [{ $divide: ["$reachedEnd", "$samples"] }, 100] }, 0],
        },
      },
    },
  ]);
}

/**
 * First-time versus repeat visitors.
 *
 * A visitor counts as returning if their hash was seen before this window
 * opened. The hash rotates daily for privacy, so this measures "came back
 * within the retention of the hash", not lifetime loyalty — worth knowing
 * before reading too much into it.
 */
async function newVsReturning(siteIds: string[], since: Date) {
  const inSites = { $in: siteIds };
  const [current, earlier] = await Promise.all([
    Event.distinct("visitorHash", { siteId: inSites, ts: { $gte: since } }),
    Event.distinct("visitorHash", { siteId: inSites, ts: { $lt: since } }),
  ]);

  const before = new Set(earlier as string[]);
  let returning = 0;
  for (const v of current as string[]) if (before.has(v)) returning++;

  const total = current.length;
  return {
    new: total - returning,
    returning,
    returningRate: total > 0 ? Math.round((returning / total) * 100) : 0,
  };
}

/** Traffic by hour of day and day of week, for a when-are-people-here heatmap. */
async function heatmap(match: Match) {
  const rows = await Event.aggregate([
    { $match: match },
    {
      $group: {
        // Mongo numbers the week 1–7 from Sunday; shift to 0–6 for the client.
        _id: { day: { $dayOfWeek: "$ts" }, hour: { $hour: "$ts" } },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        day: { $subtract: ["$_id.day", 1] },
        hour: "$_id.hour",
        count: 1,
      },
    },
  ]);
  return rows as { day: number; hour: number; count: number }[];
}

/**
 * Per landing page: how many sessions it started, and whether those sessions
 * went anywhere. A page can pull plenty of traffic and still leak all of it.
 */
async function landingPages(siteIds: string[], since: Date, limit = 10) {
  const inSites = { $in: siteIds };
  const window = { siteId: inSites, ts: { $gte: since } };

  // The entry path lives on the pageview and the bounce outcome on the
  // engagement record, so neither alone can answer this — roll the session up
  // first, then group the sessions by where they started.
  const rows = await Event.aggregate([
    { $match: { ...window, type: { $in: ["pageview", "engagement"] } } },
    {
      $group: {
        _id: "$sessionId",
        entry: {
          $first: {
            $cond: [{ $eq: ["$type", "pageview"] }, "$entryPath", "$$REMOVE"],
          },
        },
        views: { $sum: { $cond: [{ $eq: ["$type", "pageview"] }, 1, 0] } },
        bounced: { $max: { $cond: ["$bounce", 1, 0] } },
      },
    },
    { $match: { entry: { $nin: [null, ""] } } },
    {
      $group: {
        _id: "$entry",
        count: { $sum: 1 },
        bounces: { $sum: "$bounced" },
        totalViews: { $sum: "$views" },
      },
    },
    {
      $project: {
        _id: 0,
        key: "$_id",
        count: 1,
        bounceRate: {
          $round: [{ $multiply: [{ $divide: ["$bounces", "$count"] }, 100] }, 0],
        },
        pagesPerSession: {
          $round: [{ $divide: ["$totalViews", "$count"] }, 1],
        },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);
  return rows as {
    key: string;
    count: number;
    bounceRate: number;
    pagesPerSession: number;
  }[];
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
    clicks,
    clickTotal,
    timeseries,
    liveNow,
    scrollRows,
    visitorSplit,
    heatmapRows,
    landingRows,
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
    topClicks(base),
    Event.countDocuments({ ...base, type: "click" }),
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
    scrollDepth(base),
    newVsReturning(siteIds, since),
    heatmap(pageviewBase),
    landingPages(siteIds, since),
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

    // clicks
    clicks: (clicks as { key: string; count: number }[]).map((c) => ({
      ...c,
      key: c.key || "(unlabelled)",
    })),
    clickCount: clickTotal,

    // how far down each page people get
    scrollDepth: scrollRows,

    // first-time vs repeat visitors
    visitorSplit,

    // traffic by hour and weekday
    heatmap: heatmapRows,

    // which entry points actually hold people
    landingPages: landingRows,

    // real-time
    livePages: liveNow,

    timeseries,
  };
}
