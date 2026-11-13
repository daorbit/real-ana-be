import { Event } from "../../analytics/models/Event.js";
import { Site } from "../../analytics/models/Site.js";
import {
  compareBreakdown,
  periodTotals,
  resolveWindow,
  type BreakdownComparisonRow,
} from "../../analytics/stats.service.js";
import { completeDays, DAY_MS, type DayWindow } from "../windows.js";
import type { SourceStatus } from "../types.js";

const STALE_AFTER_MS = 3 * DAY_MS;
const FRESHNESS_LOOKBACK_MS = 30 * DAY_MS;
const ENTRY_ROWS = 200;

export const WEEK_DAYS = 7;
export const PAGE_DAYS = 28;

type Totals = Awaited<ReturnType<typeof periodTotals>>["current"];

export type RadarSite = { siteId: string; name: string; domain: string };

export type AnalyticsData = {
  sites: RadarSite[];
  siteIds: string[];
  week: { window: DayWindow; current: Totals; previous: Totals };
  entryPages: { window: DayWindow; rows: BreakdownComparisonRow[]; totalSessions: number };
};

export type SourceResult<T> = { status: SourceStatus; data: T | null };

function windowOf(days: DayWindow) {
  return resolveWindow("custom", days.since.getTime(), days.until.getTime());
}

async function lastEventAt(siteIds: string[], now: Date): Promise<Date | null> {
  const last = await Event.findOne({ siteId: { $in: siteIds }, ts: { $gte: new Date(now.getTime() - FRESHNESS_LOOKBACK_MS) } })
    .sort({ ts: -1 })
    .select("ts")
    .lean<{ ts: Date }>();
  return last?.ts ?? null;
}

export async function loadAnalytics(workspaceId: string, now: Date): Promise<SourceResult<AnalyticsData>> {
  const rows = await Site.find({ workspaceId }).select("siteId name domain").lean();
  const sites = rows.map((s) => ({ siteId: String(s.siteId), name: String(s.name ?? ""), domain: String(s.domain ?? "") }));
  if (!sites.length) {
    return { status: { id: "analytics", state: "not_connected", detail: "No site is tracked in this workspace yet.", freshAt: null }, data: null };
  }

  const siteIds = sites.map((s) => s.siteId);
  const week = completeDays(WEEK_DAYS, now);
  const month = completeDays(PAGE_DAYS, now);

  const [freshAt, weekTotals, entryRows] = await Promise.all([
    lastEventAt(siteIds, now),
    periodTotals(siteIds, windowOf(week)),
    compareBreakdown(siteIds, "entryPath", windowOf(month), undefined, ENTRY_ROWS),
  ]);

  if (!freshAt || now.getTime() - freshAt.getTime() > STALE_AFTER_MS) {
    return {
      status: {
        id: "analytics",
        state: "stale",
        detail: freshAt ? "No visits have arrived for more than 3 days. Check the tracking script." : "No visits recorded in the last 30 days.",
        freshAt,
      },
      data: null,
    };
  }

  return {
    status: {
      id: "analytics",
      state: "ready",
      detail: sites.length === 1 ? sites[0].name : `${sites.length} sites`,
      freshAt,
    },
    data: {
      sites,
      siteIds,
      week: { window: week, current: weekTotals.current, previous: weekTotals.previous },
      entryPages: {
        window: month,
        rows: entryRows,
        totalSessions: entryRows.reduce((sum, r) => sum + r.count, 0),
      },
    },
  };
}
