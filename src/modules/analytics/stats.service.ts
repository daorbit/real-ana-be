import { Event } from "./models/Event.js";

export const TRACKER_VERSION = 5;

export const RANGES: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const LIVE_WINDOW_MS = 5 * 60 * 1000;

type Match = Record<string, unknown>;

export type CompareMode = "previous" | "yoy" | "custom";

export const COMPARE_MODES: CompareMode[] = ["previous", "yoy", "custom"];

export function parseCompareMode(raw: unknown): CompareMode {
  return COMPARE_MODES.includes(raw as CompareMode) ? (raw as CompareMode) : "previous";
}

export type Window = {
  rangeKey: string;
  since: Date;
  until: Date;
  windowMs: number;
  prevSince: Date;
  prevUntil: Date;
  compare: CompareMode;
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function resolveWindow(
  rangeKey: string,
  from?: unknown,
  to?: unknown,
  compare: CompareMode = "previous",
  compareFrom?: unknown,
  compareTo?: unknown,
): Window {
  const now = Date.now();
  const toMs = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  };

  // Resolve the current window first; the baseline is derived from its bounds.
  let start: number;
  let end: number;
  let key: string;

  const f = toMs(from);
  const t = toMs(to);
  if (rangeKey === "custom" && f != null && t != null) {
    start = Math.min(f, t);
    end = Math.max(f, t);
    if (end - start < 60_000) end = start + 60_000;
    if (end - start > YEAR_MS) start = end - YEAR_MS;
    key = "custom";
  } else {
    const windowMs = RANGES[rangeKey] ?? RANGES["24h"];
    key = RANGES[rangeKey] ? rangeKey : "24h";
    end = now;
    start = now - windowMs;
  }

  const windowMs = end - start;

  // Default: the equal-length period ending where the current one begins.
  let prevStart = start - windowMs;
  let prevEnd = start;
  let mode: CompareMode = "previous";

  if (compare === "yoy") {
    prevStart = start - YEAR_MS;
    prevEnd = prevStart + windowMs;
    mode = "yoy";
  } else if (compare === "custom") {
    const cf = toMs(compareFrom);
    const ct = toMs(compareTo);
    if (cf != null) {
      prevStart = ct != null ? Math.min(cf, ct) : cf;
      prevEnd = prevStart + windowMs;
      mode = "custom";
    }
  }

  return {
    rangeKey: key,
    since: new Date(start),
    until: new Date(end),
    windowMs,
    prevSince: new Date(prevStart),
    prevUntil: new Date(prevEnd),
    compare: mode,
  };
}

export type StatsFilter = Partial<{
  country: string;
  device: string;
  browser: string;
  os: string;
  referrer: string;
  path: string;
  language: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  eventName: string;
}>;

const FILTER_FIELDS: Record<keyof StatsFilter, string> = {
  country: "country",
  device: "device",
  browser: "browser",
  os: "os",
  referrer: "referrer",
  path: "path",
  language: "language",
  utmSource: "utm.source",
  utmMedium: "utm.medium",
  utmCampaign: "utm.campaign",
  eventName: "name",
};

const FILTER_KEYS = new Set(Object.keys(FILTER_FIELDS));

/**
 * Parse the `?filter=` query value into a StatsFilter. Format is
 * `key:value;key:value` — semicolon-separated so values may contain commas
 * (referrers, campaign names). Unknown keys are dropped.
 */
export function parseFilters(raw: unknown): StatsFilter {
  if (typeof raw !== "string" || !raw) return {};
  const out: StatsFilter = {};
  for (const pair of raw.split(";")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    const key = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (FILTER_KEYS.has(key) && value) {
      (out as Record<string, string>)[key] = value.slice(0, 200);
    }
  }
  return out;
}

/** Turn a StatsFilter into Mongo match fragments merged into every pipeline. */
function filterMatch(filters?: StatsFilter): Match {
  const match: Match = {};
  if (!filters) return match;
  for (const [key, field] of Object.entries(FILTER_FIELDS)) {
    const value = filters[key as keyof StatsFilter];
    if (value != null && value !== "") match[field] = value;
  }
  return match;
}

async function topBy(match: Match, field: string, limit = 8) {
  return Event.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    ...(limit > 0 ? [{ $limit: limit }] : []),
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ]);
}

/** Headline counters for one window — used for both the current and previous period. */
async function totals(siteIds: string[], from: Date, to: Date, fMatch: Match = {}) {
  const inSites = { $in: siteIds };
  const window = { siteId: inSites, ts: { $gte: from, $lt: to }, ...fMatch };

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

async function newVsReturning(siteIds: string[], since: Date, until: Date, fMatch: Match = {}) {
  const inSites = { $in: siteIds };
  const [current, earlier] = await Promise.all([
    Event.distinct("visitorHash", { siteId: inSites, ts: { $gte: since, $lt: until }, ...fMatch }),
    Event.distinct("visitorHash", { siteId: inSites, ts: { $lt: since }, ...fMatch }),
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

async function heatmap(match: Match) {
  const rows = await Event.aggregate([
    { $match: match },
    {
      $group: {
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

async function landingPages(siteIds: string[], since: Date, until: Date, fMatch: Match = {}, limit = 10) {
  const inSites = { $in: siteIds };
  const window = { siteId: inSites, ts: { $gte: since, $lt: until }, ...fMatch };

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

async function customEvents(match: Match, limit = 12) {
  const rows = await Event.aggregate([
    { $match: { ...match, type: "custom", name: { $nin: [null, ""] } } },
    {
      $addFields: {
        _value: {
          $convert: { input: "$props.value", to: "double", onError: 0, onNull: 0 },
        },
      },
    },
    {
      $group: {
        _id: "$name",
        count: { $sum: 1 },
        visitors: { $addToSet: "$visitorHash" },
        revenue: { $sum: "$_value" },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        key: "$_id",
        count: 1,
        visitors: { $size: "$visitors" },
        revenue: { $round: ["$revenue", 2] },
      },
    },
  ]);
  return rows as {
    key: string;
    count: number;
    visitors: number;
    revenue: number;
  }[];
}

export async function computeRetention(siteIds: string[], weeks = 6) {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const since = new Date(now - weeks * WEEK_MS);
  // Anchor weeks to a fixed epoch Monday so cohorts line up across visitors.
  const anchor = new Date(now - weeks * WEEK_MS).getTime();

  const rows = await Event.aggregate([
    { $match: { siteId: { $in: siteIds }, ts: { $gte: since } } },
    // Which week bucket (0-based from the anchor) each event falls in.
    {
      $group: {
        _id: "$visitorHash",
        weeksActive: {
          $addToSet: {
            $floor: { $divide: [{ $subtract: ["$ts", new Date(anchor)] }, WEEK_MS] },
          },
        },
      },
    },
    {
      $project: {
        cohort: { $min: "$weeksActive" },
        weeksActive: 1,
      },
    },
    {
      $group: {
        _id: "$cohort",
        size: { $sum: 1 },
        // Flatten every (cohort, activeWeek) into offsets for counting below.
        offsets: {
          $push: {
            $map: {
              input: "$weeksActive",
              as: "w",
              in: { $subtract: ["$$w", "$cohort"] },
            },
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return (rows as { _id: number; size: number; offsets: number[][] }[]).map((c) => {
    // Count, for this cohort, how many visitors were active at each week offset.
    const perOffset: number[] = Array(weeks).fill(0);
    for (const list of c.offsets) {
      for (const off of list) {
        if (off >= 0 && off < weeks) perOffset[off] += 1;
      }
    }
    const base = perOffset[0] || c.size || 1;
    return {
      // Week index from the start of the observed window.
      cohort: c._id,
      size: c.size,
      // retention[0] is always 100% (the cohort itself)
      retention: perOffset.map((n) => Math.round((n / base) * 100)),
    };
  });
}

export type FunnelStep = { type: "page" | "event"; value: string };

export async function computeFunnel(
  siteIds: string[],
  steps: FunnelStep[],
  rangeKey: string,
  win?: Window
) {
  const { since, until } = win ?? resolveWindow(rangeKey);
  const n = steps.length;

  // A per-step condition matching the right event kind and value.
  const stepCond = (s: FunnelStep) =>
    s.type === "event"
      ? { $and: [{ $eq: ["$type", "custom"] }, { $eq: ["$name", s.value] }] }
      : { $and: [{ $eq: ["$type", "pageview"] }, { $eq: ["$path", s.value] }] };

  // The earliest ts each session hit each step, as an array [t0, t1, ...],
  // with null where a step was never reached.
  const stepTimes = steps.map((s, i) => ({
    [`t${i}`]: {
      $min: { $cond: [stepCond(s), "$ts", null] },
    },
  }));

  const rows = await Event.aggregate([
    { $match: { siteId: { $in: siteIds }, ts: { $gte: since, $lt: until } } },
    { $group: { _id: "$sessionId", ...Object.assign({}, ...stepTimes) } },
    {
      // reached[i] is true when every step up to i was hit in non-decreasing
      // time order. Built iteratively in a $let so later steps depend on earlier.
      $project: {
        reached: {
          $let: {
            vars: {
              times: steps.map((_s, i) => `$t${i}`),
            },
            in: {
              $reduce: {
                input: { $range: [0, n] },
                initialValue: { ok: true, prev: null, flags: [] as boolean[] },
                in: {
                  $let: {
                    vars: {
                      t: { $arrayElemAt: ["$$times", "$$this"] },
                    },
                    in: {
                      $let: {
                        vars: {
                          hit: {
                            $and: [
                              "$$value.ok",
                              { $ne: ["$$t", null] },
                              {
                                $or: [
                                  { $eq: ["$$value.prev", null] },
                                  { $gte: ["$$t", "$$value.prev"] },
                                ],
                              },
                            ],
                          },
                        },
                        in: {
                          ok: "$$hit",
                          prev: { $cond: ["$$hit", "$$t", "$$value.prev"] },
                          flags: { $concatArrays: ["$$value.flags", ["$$hit"]] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    { $project: { flags: "$reached.flags" } },
    // Sum each step's reached-flag across all sessions.
    {
      $group: {
        _id: null,
        ...Object.assign(
          {},
          ...steps.map((_s, i) => ({
            [`s${i}`]: { $sum: { $cond: [{ $arrayElemAt: ["$flags", i] }, 1, 0] } },
          }))
        ),
      },
    },
  ]);

  const agg = (rows[0] ?? {}) as Record<string, number>;
  const counts = steps.map((_s, i) => agg[`s${i}`] ?? 0);
  const entered = counts[0] || 0;

  return steps.map((s, i) => ({
    label: s.value,
    type: s.type,
    count: counts[i],
    // conversion from the top of the funnel
    rate: entered > 0 ? Math.round((counts[i] / entered) * 100) : 0,
    // drop-off from the previous step
    dropFromPrev:
      i === 0 || counts[i - 1] === 0
        ? 0
        : Math.round(((counts[i - 1] - counts[i]) / counts[i - 1]) * 100),
  }));
}

export type FlowNode = { id: string; count: number };
export type FlowEdge = { source: string; target: string; count: number };

/**
 * Page-to-page navigation graph: for each session, the pageviews in time
 * order become a path, and every adjacent pair becomes an A -> B edge. Caps
 * both the number of sessions scanned and the pages kept, since a busy site
 * can have thousands of distinct paths in a single window.
 */
export async function computeUserFlow(siteIds: string[], rangeKey: string, win?: Window) {
  const { since, until } = win ?? resolveWindow(rangeKey);

  const sessions = await Event.aggregate([
    { $match: { siteId: { $in: siteIds }, type: "pageview", ts: { $gte: since, $lt: until } } },
    { $sort: { ts: 1 } },
    { $group: { _id: "$sessionId", paths: { $push: "$path" } } },
    { $limit: 20000 },
  ]);

  const nodeCounts = new Map<string, number>();
  const edgeCounts = new Map<string, number>();

  for (const s of sessions) {
    const paths: string[] = s.paths ?? [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      nodeCounts.set(p, (nodeCounts.get(p) ?? 0) + 1);
      if (i > 0) {
        const prev = paths[i - 1];
        // Skip a page refreshing into itself — not a navigation.
        if (prev === p) continue;
        const key = `${prev} ${p}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Keep only the busiest pages so the graph stays readable, then drop any
  // edge that fell outside that set.
  const nodes: FlowNode[] = [...nodeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([id, count]) => ({ id, count }));
  const kept = new Set(nodes.map((n) => n.id));

  const edges: FlowEdge[] = [...edgeCounts.entries()]
    .map(([key, count]) => {
      const [source, target] = key.split(" ");
      return { source, target, count };
    })
    .filter((e) => kept.has(e.source) && kept.has(e.target))
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);

  return { nodes, edges };
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


async function channels(match: Match) {
  const referrerSource = {
    $cond: [
      { $ne: [{ $ifNull: ["$utm.landingReferrer", ""] }, ""] },
      "$utm.landingReferrer",
      { $ifNull: ["$referrer", ""] },
    ],
  };
  const host = {
    $let: {
      vars: {
        noProto: {
          $replaceAll: {
            input: {
              $replaceAll: {
                input: { $toLower: referrerSource },
                find: "https://",
                replacement: "",
              },
            },
            find: "http://",
            replacement: "",
          },
        },
      },
      in: { $arrayElemAt: [{ $split: ["$$noProto", "/"] }, 0] },
    },
  };
  const has = (needle: string, on: unknown) =>
    ({ $gte: [{ $indexOfCP: [on, needle] }, 0] });

  const rows = await Event.aggregate([
    { $match: match },
    {
      $addFields: {
        _medium: { $toLower: { $ifNull: ["$utm.medium", ""] } },
        _clickId: { $toLower: { $ifNull: ["$utm.clickId", ""] } },
        _host: host,
      },
    },
    {
      $addFields: {
        channel: {
          $switch: {
            branches: [
              {
                case: {
                  $or: [
                    has("cpc", "$_medium"), has("ppc", "$_medium"), has("paid", "$_medium"),
                    { $eq: ["$_medium", "display"] },
                    // An ad click id is paid traffic even when the landing URL
                    // carries no utm_* tags at all, which is common for
                    // auto-tagged Google and Meta campaigns.
                    { $ne: ["$_clickId", ""] },
                  ],
                },
                then: "Paid",
              },
              {
                case: {
                  $or: [
                    { $eq: ["$_medium", "email"] },
                    { $eq: ["$_medium", "newsletter"] },
                    // Webmail referrers: a click from Gmail or Outlook rarely
                    // carries utm_medium=email unless the sender tagged it.
                    has("mail.google.", "$_host"), has("mail.yahoo.", "$_host"),
                    has("outlook.", "$_host"), has("mail.proton", "$_host"),
                    has("mail.zoho.", "$_host"),
                  ],
                },
                then: "Email",
              },
              {
                case: {
                  $or: [
                    has("facebook.", "$_host"), has("twitter.", "$_host"), has("t.co", "$_host"),
                    has("x.com", "$_host"), has("linkedin.", "$_host"), has("instagram.", "$_host"),
                    has("youtube.", "$_host"), has("reddit.", "$_host"), has("pinterest.", "$_host"),
                    has("tiktok.", "$_host"),
                  ],
                },
                then: "Social",
              },
              {
                case: {
                  $or: [
                    has("google.", "$_host"), has("bing.", "$_host"), has("duckduckgo.", "$_host"),
                    has("yahoo.", "$_host"), has("ecosia.", "$_host"), has("baidu.", "$_host"),
                    has("yandex.", "$_host"),
                  ],
                },
                then: "Organic Search",
              },
              { case: { $ne: ["$_host", ""] }, then: "Referral" },
            ],
            default: "Direct",
          },
        },
      },
    },
    { $group: { _id: "$channel", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ]);
  return rows as { key: string; count: number }[];
}

/**
 * Where visitors go when they leave: outbound link clicks and file downloads.
 * The tracker tags these with clickTag "outbound" or "download", so they group
 * by destination rather than the on-page label.
 */
async function outboundClicks(match: Match, limit = 10) {
  return Event.aggregate([
    { $match: { ...match, type: "click", clickTag: { $in: ["outbound", "download"] } } },
    {
      $group: {
        _id: { href: "$clickHref", kind: "$clickTag" },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
    { $project: { _id: 0, key: "$_id.href", kind: "$_id.kind", count: 1 } },
  ]) as Promise<{ key: string; kind: string; count: number }[]>;
}


async function topErrors(match: Match, limit = 10) {
  return Event.aggregate([
    { $match: { ...match, type: "error" } },
    {
      $group: {
        _id: { message: "$name", path: "$path" },
        count: { $sum: 1 },
        lastSeen: { $max: "$ts" },
      },
    },
    { $sort: { count: -1 } },
    { $limit: limit },
    { $project: { _id: 0, key: "$_id.message", path: "$_id.path", count: 1, lastSeen: 1 } },
  ]) as Promise<{ key: string; path: string; count: number; lastSeen: Date }[]>;
}

export type GoalDef = { id: string; name: string; kind: "page" | "event"; match: string };

/**
 * Conversion rate for each goal over the window.
 *
 * A goal converts once per visitor: the count is distinct visitors who matched
 * it (a pageview of the path, or a custom event of the name), and the rate is
 * that over all visitors in the window. Distinct-visitor keeps a page someone
 * refreshed ten times from inflating the number.
 */
export async function computeGoals(
  siteIds: string[],
  goals: GoalDef[],
  rangeKey: string,
  totalVisitors: number,
  fMatch: Match = {},
  win?: Window
) {
  if (goals.length === 0) return [];
  const { since, until } = win ?? resolveWindow(rangeKey);
  const base = { siteId: { $in: siteIds }, ts: { $gte: since, $lt: until }, ...fMatch };

  return Promise.all(
    goals.map(async (g) => {
      const cond =
        g.kind === "event"
          ? { ...base, type: "custom", name: g.match }
          : { ...base, type: "pageview", path: g.match };
      const visitors = await Event.distinct("visitorHash", cond);
      const conversions = visitors.length;
      return {
        id: g.id,
        name: g.name,
        kind: g.kind,
        match: g.match,
        conversions,
        conversionRate:
          totalVisitors > 0 ? Math.round((conversions / totalVisitors) * 1000) / 10 : 0,
      };
    })
  );
}

/** A raw event row for CSV/XLSX export, flattened and privacy-trimmed. */
export type ExportRow = {
  timestamp: string;
  type: string;
  name: string;
  path: string;
  referrer: string;
  device: string;
  os: string;
  browser: string;
  country: string;
  language: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  /** Ad click id as "param:value", e.g. "gclid:abc123". */
  utmClickId: string;
  durationMs: number;
  scrollDepth: number;
};

/** Columns, in order, for the export — the CSV header and XLSX column set. */
export const EXPORT_COLUMNS: (keyof ExportRow)[] = [
  "timestamp", "type", "name", "path", "referrer", "device", "os", "browser",
  "country", "language", "utmSource", "utmMedium", "utmCampaign",
  "utmTerm", "utmContent", "utmClickId",
  "durationMs", "scrollDepth",
];

/**
 * Raw events in the window, newest first, for download.
 *
 * Capped so an export can't stream the whole collection into memory. Only the
 * behavioural fields ship — never the visitor hash, IP, or session id — so an
 * export can't be used to re-identify anyone.
 */
export async function exportEvents(
  siteIds: string[],
  win: Window,
  filters?: StatsFilter,
  limit = 50_000
): Promise<ExportRow[]> {
  const fMatch = filterMatch(filters);
  const rows = await Event.find({
    siteId: { $in: siteIds },
    ts: { $gte: win.since, $lt: win.until },
    ...fMatch,
  })
    .sort({ ts: -1 })
    .limit(limit)
    .lean();

  return rows.map((e: Record<string, any>) => ({
    timestamp: new Date(e.ts).toISOString(),
    type: e.type ?? "",
    name: e.name ?? "",
    path: e.path ?? "",
    referrer: e.referrer ?? "",
    device: e.device ?? "",
    os: e.os ?? "",
    browser: e.browser ?? "",
    country: e.country ?? "",
    language: e.language ?? "",
    utmSource: e.utm?.source ?? "",
    utmMedium: e.utm?.medium ?? "",
    utmCampaign: e.utm?.campaign ?? "",
    utmTerm: e.utm?.term ?? "",
    utmContent: e.utm?.content ?? "",
    utmClickId: e.utm?.clickId ?? "",
    durationMs: e.durationMs ?? 0,
    scrollDepth: e.scrollDepth ?? 0,
  }));
}
 
async function timeseriesFor(match: Match, windowMs: number) {
  return Event.aggregate([
    { $match: match },
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
  ]);
}

export async function computeStats(
  siteIds: string[],
  rangeKey: string,
  filters?: StatsFilter,
  win?: Window,
  withCompareSeries = false,
) {
  const w = win ?? resolveWindow(rangeKey);
  const { since, until, prevSince, prevUntil, windowMs } = w;
  const liveSince = new Date(Date.now() - LIVE_WINDOW_MS);

  const fMatch = filterMatch(filters);
  const inSites = { $in: siteIds };
  // Bounded on both ends so a custom window doesn't spill past its end date.
  const base: Match = { siteId: inSites, ts: { $gte: since, $lt: until }, ...fMatch };
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
    utmMediums,
    utmCampaigns,
    clicks,
    clickTotal,
    timeseries,
    liveNow,
    scrollRows,
    visitorSplit,
    heatmapRows,
    landingRows,
    eventRows,
    channelRows,
    outboundRows,
    errorRows,
    compareSeries,
  ] = await Promise.all([
    totals(siteIds, since, until, fMatch),
    totals(siteIds, prevSince, prevUntil, fMatch),
    Event.distinct("visitorHash", { siteId: inSites, ts: { $gte: liveSince }, ...fMatch }),
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
    topBy(base, "utm.medium"),
    topBy(base, "utm.campaign"),
    topClicks(base),
    Event.countDocuments({ ...base, type: "click" }),
    timeseriesFor(pageviewBase, windowMs),
    livePages(siteIds),
    scrollDepth(base),
    newVsReturning(siteIds, since, until, fMatch),
    heatmap(pageviewBase),
    landingPages(siteIds, since, until, fMatch),
    customEvents(base),
    // Channels grouped per session, so count entry pageviews rather than every view.
    channels({ ...pageviewBase, isEntry: true }),
    outboundClicks(base),
    topErrors(base),
    withCompareSeries
      ? timeseriesFor(
          { siteId: inSites, ts: { $gte: prevSince, $lt: prevUntil }, ...fMatch, type: "pageview" },
          windowMs,
        )
      : Promise.resolve(null),
  ]);

  // Conversion is against total visitors in the window, known only now that the
  // headline totals have resolved.
  const events = eventRows.map((r) => ({
    ...r,
    conversionRate:
      current.visitors > 0 ? Math.round((r.visitors / current.visitors) * 100) : 0,
  }));
  const totalRevenue =
    Math.round(events.reduce((sum, e) => sum + (e.revenue ?? 0), 0) * 100) / 100;

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

    // change vs. the baseline period
    deltas: {
      pageviews: delta(current.pageviews, previous.pageviews),
      visitors: delta(current.visitors, previous.visitors),
      sessions: delta(current.sessions, previous.sessions),
      bounceRate: delta(current.bounceRate, previous.bounceRate),
      avgSessionMs: delta(current.avgSessionMs, previous.avgSessionMs),
      pagesPerSession: delta(current.pagesPerSession, previous.pagesPerSession),
    },

    comparison: {
      mode: w.compare,
      since: prevSince,
      until: prevUntil,
      pageviews: previous.pageviews,
      visitors: previous.visitors,
      sessions: previous.sessions,
      bounceRate: previous.bounceRate,
      avgSessionMs: previous.avgSessionMs,
      avgTimeOnPageMs: previous.avgTimeOnPageMs,
      pagesPerSession: previous.pagesPerSession,
      // null unless the caller asked for the overlay.
      timeseries: compareSeries,
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
    utmMediums: clean(utmMediums, "(none)"),
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

    // custom events fired via rta.track()
    customEvents: events,
    // summed props.value across all custom events (goal revenue)
    totalRevenue,

    // marketing channels: how sessions arrived (Direct/Organic/Paid/Social/…)
    channels: channelRows,

    // where visitors leave to: outbound links and file downloads
    outboundClicks: outboundRows,

    // client-side errors the tracker forwarded
    errors: errorRows,

    // real-time
    livePages: liveNow,

    timeseries,
  };
}

const COMPARABLE_DIMENSIONS: Record<string, { field: string; type?: string }> = {
  path: { field: "path", type: "pageview" },
  referrer: { field: "referrer" },
  device: { field: "device", type: "pageview" },
  browser: { field: "browser", type: "pageview" },
  os: { field: "os", type: "pageview" },
  country: { field: "country", type: "pageview" },
  language: { field: "language", type: "pageview" },
  utmSource: { field: "utm.source" },
  utmMedium: { field: "utm.medium" },
  utmCampaign: { field: "utm.campaign" },
};

export const COMPARABLE_DIMENSION_KEYS = Object.keys(COMPARABLE_DIMENSIONS);

export type BreakdownComparisonRow = {
  key: string;
  count: number;
  previous: number;
  delta: number | null;
};

export async function compareBreakdown(
  siteIds: string[],
  dimension: string,
  win: Window,
  filters?: StatsFilter,
  limit = 8,
): Promise<BreakdownComparisonRow[]> {
  const dim = COMPARABLE_DIMENSIONS[dimension];
  if (!dim) throw new Error(`not a comparable dimension: ${dimension}`);

  const fMatch = filterMatch(filters);
  const inSites = { $in: siteIds };
  const typeMatch = dim.type ? { type: dim.type } : {};


  const [currentRows, previousRows] = await Promise.all([
    topBy(
      { siteId: inSites, ts: { $gte: win.since, $lt: win.until }, ...typeMatch, ...fMatch },
      dim.field,
      0,
    ),
    topBy(
      { siteId: inSites, ts: { $gte: win.prevSince, $lt: win.prevUntil }, ...typeMatch, ...fMatch },
      dim.field,
      0,
    ),
  ]);

  const prevByKey = new Map<string, number>();
  for (const r of previousRows as { key: string; count: number }[]) {
    prevByKey.set(r.key ?? "", r.count);
  }

  const rows: BreakdownComparisonRow[] = (currentRows as { key: string; count: number }[]).map(
    (r) => {
      const key = r.key ?? "";
      const previous = prevByKey.get(key) ?? 0;
      prevByKey.delete(key);
      return { key, count: r.count, previous, delta: delta(r.count, previous) };
    },
  );

  for (const [key, previous] of prevByKey) {
    rows.push({ key, count: 0, previous, delta: delta(0, previous) });
  }

  rows.sort((a, b) => Math.max(b.count, b.previous) - Math.max(a.count, a.previous));
  return rows.slice(0, limit);
}
