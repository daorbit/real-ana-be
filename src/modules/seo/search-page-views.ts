import { Event } from "../analytics/models/Event.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PATHS = 20000;

export type DateRange = { startDate: string; endDate: string };

export type PageViewSeries = {
  total: number;
  previous: number;
  daily: Array<{ date: string; views: number }>;
};

export function pathOf(urlOrPath: string): string {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath.split(/[?#]/)[0] ?? "/";
  }
  if (!path.startsWith("/")) path = `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

function window(range: DateRange) {
  return {
    $gte: new Date(`${range.startDate}T00:00:00.000Z`),
    $lt: new Date(new Date(`${range.endDate}T00:00:00.000Z`).getTime() + DAY_MS),
  };
}

export async function pageViewsByPath(siteId: string, range: DateRange): Promise<Record<string, number>> {
  const rows = await Event.aggregate<{ _id: string; views: number }>([
    { $match: { siteId, type: "pageview", ts: window(range) } },
    { $group: { _id: "$path", views: { $sum: 1 } } },
    { $sort: { views: -1 } },
    { $limit: MAX_PATHS },
  ]);

  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = pathOf(String(row._id ?? "/"));
    out[key] = (out[key] ?? 0) + row.views;
  }
  return out;
}

function pathMatch(path: string) {
  return path === "/" ? { $in: ["/", ""] } : { $in: [path, `${path}/`] };
}

export async function pageViewSeries(
  siteId: string,
  url: string,
  current: DateRange,
  previous: DateRange,
): Promise<PageViewSeries> {
  const path = pathMatch(pathOf(url));

  const [daily, before] = await Promise.all([
    Event.aggregate<{ _id: string; views: number }>([
      { $match: { siteId, type: "pageview", path, ts: window(current) } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } }, views: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Event.countDocuments({ siteId, type: "pageview", path, ts: window(previous) }),
  ]);

  return {
    total: daily.reduce((sum, d) => sum + d.views, 0),
    previous: before,
    daily: daily.map((d) => ({ date: d._id, views: d.views })),
  };
}
