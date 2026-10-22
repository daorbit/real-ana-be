import { HeatmapClick } from "./models/HeatmapClick.js";
import type { Window } from "./stats.service.js";

export const HEATMAP_DEVICES = ["desktop", "mobile", "tablet"] as const;
export type HeatmapDevice = (typeof HEATMAP_DEVICES)[number];

export const HEATMAP_GRID = { x: 40, y: 120 } as const;
const SCROLL_BANDS = 10;
const MAX_PAGES = 50;

export type HeatmapPageRow = { path: string; clicks: number; sessions: number };

export type HeatmapCell = { x: number; y: number; n: number };

export type PageHeatmap = {
  path: string;
  device: HeatmapDevice;
  grid: { x: number; y: number };
  clicks: number;
  cells: HeatmapCell[];
  scroll: { sessions: number; reach: number[] };
};

export function parseHeatmapDevice(value: unknown): HeatmapDevice {
  return HEATMAP_DEVICES.includes(value as HeatmapDevice) ? (value as HeatmapDevice) : "desktop";
}

function baseMatch(siteIds: string[], win: Window, device: HeatmapDevice) {
  return { siteId: { $in: siteIds }, device, ts: { $gte: win.since, $lt: win.until } };
}

function gridIndex(field: string, cells: number) {
  return { $min: [cells - 1, { $floor: { $multiply: [field, cells / 100] } }] };
}

export async function computeHeatmapPages(
  siteIds: string[],
  win: Window,
  device: HeatmapDevice,
): Promise<HeatmapPageRow[]> {
  return HeatmapClick.aggregate<HeatmapPageRow>([
    { $match: baseMatch(siteIds, win, device) },
    {
      $group: {
        _id: "$path",
        clicks: { $sum: { $cond: [{ $eq: ["$type", "click"] }, 1, 0] } },
        sessions: { $addToSet: "$sessionId" },
      },
    },
    { $project: { _id: 0, path: "$_id", clicks: 1, sessions: { $size: "$sessions" } } },
    { $sort: { clicks: -1, sessions: -1 } },
    { $limit: MAX_PAGES },
  ]);
}

function scrollReach(buckets: { _id: number; n: number }[]): { sessions: number; reach: number[] } {
  const sessions = buckets.reduce((sum, b) => sum + b.n, 0);
  const reach = Array.from({ length: SCROLL_BANDS }, (_, band) => {
    if (!sessions) return 0;
    const reached = buckets.filter((b) => b._id >= band).reduce((sum, b) => sum + b.n, 0);
    return Math.round((reached / sessions) * 100);
  });
  return { sessions, reach };
}

export async function computePageHeatmap(
  siteIds: string[],
  path: string,
  win: Window,
  device: HeatmapDevice,
): Promise<PageHeatmap> {
  const match = { ...baseMatch(siteIds, win, device), path };

  const [cells, depths] = await Promise.all([
    HeatmapClick.aggregate<HeatmapCell>([
      { $match: { ...match, type: "click" } },
      {
        $group: {
          _id: { x: gridIndex("$xPct", HEATMAP_GRID.x), y: gridIndex("$yPct", HEATMAP_GRID.y) },
          n: { $sum: 1 },
        },
      },
      { $project: { _id: 0, x: "$_id.x", y: "$_id.y", n: 1 } },
    ]),
    HeatmapClick.aggregate<{ _id: number; n: number }>([
      { $match: { ...match, type: "scroll" } },
      { $group: { _id: "$sessionId", depth: { $max: "$scrollPct" } } },
      { $group: { _id: gridIndex("$depth", SCROLL_BANDS), n: { $sum: 1 } } },
    ]),
  ]);

  return {
    path,
    device,
    grid: { x: HEATMAP_GRID.x, y: HEATMAP_GRID.y },
    clicks: cells.reduce((sum, c) => sum + c.n, 0),
    cells,
    scroll: scrollReach(depths),
  };
}
