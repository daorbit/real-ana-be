import { Event } from "../analytics/models/Event.js";
import { Subscription } from "../billing/models/Subscription.js";
import { UsageMonth } from "../billing/models/UsageMonth.js";
import { rollUsageMonth, usageMonthKey } from "../billing/usage-month.js";
import { SearchConsoleProperty } from "../seo/models/SearchConsoleProperty.js";
import {
  getSearchPerformance,
  searchSiteRef,
  withGoogleSession,
} from "../seo/search-console.service.js";
import type { PeriodWindow } from "./period.js";
import type { TargetMetric } from "./models/GoalTarget.js";

export type MetricReading =
  | { status: "ok"; value: number; windowLabel?: string }
  | { status: "unavailable"; reason: string };

export type TargetInput = {
  workspaceId: string;
  metric: TargetMetric;
  siteIds: string[];
  siteId: string;
};

const SEARCH_DAYS = 28;

async function distinctCount(match: Record<string, unknown>, field: string): Promise<number> {
  const [row] = await Event.aggregate([
    { $match: match },
    { $group: { _id: `$${field}` } },
    { $count: "n" },
  ]);
  return (row?.n as number) ?? 0;
}

function eventWindow(siteIds: string[], period: PeriodWindow) {
  return { siteId: { $in: siteIds }, ts: { $gte: period.start, $lt: period.end } };
}

async function readTraffic(metric: "visitors" | "pageviews" | "sessions", siteIds: string[], period: PeriodWindow) {
  const match = eventWindow(siteIds, period);
  if (metric === "pageviews") return Event.countDocuments({ ...match, type: "pageview" });
  return distinctCount(match, metric === "visitors" ? "visitorHash" : "sessionId");
}

async function readFormSubmissions(workspaceId: string, period: PeriodWindow): Promise<number> {
  await rollUsageMonth(workspaceId);
  const current = usageMonthKey();
  const [sub, archived] = await Promise.all([
    Subscription.findOne({ workspaceId }).select("formSubmissionsUsed"),
    UsageMonth.find({
      workspaceId,
      month: { $in: period.months.filter((m) => m !== current) },
    }).select("formSubmissions"),
  ]);

  const live = period.months.includes(current) ? ((sub?.get("formSubmissionsUsed") as number) ?? 0) : 0;
  return archived.reduce((sum, row) => sum + ((row.get("formSubmissions") as number) ?? 0), live);
}

async function readSearchPosition(workspaceId: string, siteId: string): Promise<MetricReading> {
  const link = siteId
    ? await SearchConsoleProperty.findOne({ workspaceId, siteId }).select("siteId")
    : await SearchConsoleProperty.findOne({ workspaceId }).select("siteId");
  if (!link) return { status: "unavailable", reason: "Link a Search Console property to track position." };

  const ref = await searchSiteRef(workspaceId, String(link.get("siteId")));
  if (!ref) return { status: "unavailable", reason: "Reconnect Search Console to track position." };

  try {
    const performance = await withGoogleSession(ref.connectionId, () =>
      getSearchPerformance(ref, SEARCH_DAYS, "web", false),
    );
    if (!performance.totals.impressions) {
      return { status: "unavailable", reason: "No search impressions in the last 28 days yet." };
    }
    return {
      status: "ok",
      value: Math.round(performance.totals.position * 10) / 10,
      windowLabel: "Last 28 days",
    };
  } catch {
    return { status: "unavailable", reason: "Google did not answer. Try again shortly." };
  }
}

export async function readMetric(input: TargetInput, period: PeriodWindow): Promise<MetricReading> {
  switch (input.metric) {
    case "visitors":
    case "pageviews":
    case "sessions":
      if (input.siteIds.length === 0) return { status: "unavailable", reason: "Add a site to start counting." };
      return { status: "ok", value: await readTraffic(input.metric, input.siteIds, period) };
    case "formSubmissions":
      return { status: "ok", value: await readFormSubmissions(input.workspaceId, period) };
    case "searchPosition":
      return readSearchPosition(input.workspaceId, input.siteId);
  }
}
