import { Types } from "mongoose";
import { InsightDigest } from "./models/InsightDigest.js";
import { detectInsights, type BreakdownRow, type Insight } from "./detect.js";
import { summarizeWeek } from "./summary.js";
import { Site } from "../analytics/models/Site.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { compareBreakdown, periodTotals, resolveWindow } from "../analytics/stats.service.js";
import { emit } from "../notifications/notify.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BREAKDOWN_ROWS = 15;
const CRON_BATCH = 8;
const CRON_CONCURRENCY = 2;
const RUN_HOUR_UTC = 6;

type DigestRow = {
  _id: Types.ObjectId;
  weekStart: Date;
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  visitors: number;
  previousVisitors: number;
  insights: Insight[];
  generatedAt: Date;
};

export function weekStartOf(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

function nextRunAfter(date: Date): Date {
  const next = new Date(weekStartOf(date).getTime() + 7 * DAY_MS);
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  return next;
}

export function presentDigest(doc: DigestRow) {
  return {
    id: String(doc._id),
    weekStart: doc.weekStart,
    periodStart: doc.periodStart,
    periodEnd: doc.periodEnd,
    summary: doc.summary ?? "",
    visitors: doc.visitors ?? 0,
    previousVisitors: doc.previousVisitors ?? 0,
    insights: doc.insights ?? [],
    generatedAt: doc.generatedAt,
  };
}

async function workspaceSiteIds(workspaceId: string): Promise<string[]> {
  const sites = await Site.find({ workspaceId }).select("siteId").lean();
  return sites.map((s) => String(s.siteId));
}

async function measure(siteIds: string[]) {
  const win = resolveWindow("7d");
  const breakdown = (dimension: string) =>
    compareBreakdown(siteIds, dimension, win, undefined, BREAKDOWN_ROWS) as Promise<BreakdownRow[]>;
  const [totals, referrers, pages, countries, devices, campaigns] = await Promise.all([
    periodTotals(siteIds, win),
    breakdown("referrer"),
    breakdown("path"),
    breakdown("country"),
    breakdown("device"),
    breakdown("utmSource"),
  ]);
  return { win, totals, referrers, pages, countries, devices, campaigns };
}

export async function generateDigest(workspaceId: string) {
  const siteIds = await workspaceSiteIds(workspaceId);
  const now = new Date();
  const weekStart = weekStartOf(now);

  let insights: Insight[] = [];
  let visitors = 0;
  let previousVisitors = 0;
  let periodStart = new Date(now.getTime() - 7 * DAY_MS);
  let periodEnd = now;

  if (siteIds.length) {
    const m = await measure(siteIds);
    insights = detectInsights(m);
    visitors = m.totals.current.visitors;
    previousVisitors = m.totals.previous.visitors;
    periodStart = m.win.since;
    periodEnd = m.win.until;
  }

  const summary = await summarizeWeek(insights, visitors, previousVisitors);
  const doc = await InsightDigest.findOneAndUpdate(
    { workspaceId, weekStart },
    { $set: { periodStart, periodEnd, summary, visitors, previousVisitors, insights, generatedAt: new Date() } },
    { upsert: true, new: true },
  ).lean();
  return presentDigest(doc as unknown as DigestRow);
}

export async function latestDigest(workspaceId: string) {
  const doc = await InsightDigest.findOne({ workspaceId }).sort({ weekStart: -1 }).lean();
  return doc ? presentDigest(doc as unknown as DigestRow) : null;
}

export async function digestById(workspaceId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) return null;
  const doc = await InsightDigest.findOne({ _id: id, workspaceId }).lean();
  return doc ? presentDigest(doc as unknown as DigestRow) : null;
}

export async function digestHistory(workspaceId: string, weeks: number) {
  const rows = await InsightDigest.find({ workspaceId })
    .sort({ weekStart: -1 })
    .limit(weeks)
    .select("weekStart insights.tone")
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    weekStart: r.weekStart,
    count: (r.insights ?? []).length,
  }));
}

export async function scheduleInsights(workspaceId: string, enabled: boolean): Promise<void> {
  await Workspace.updateOne({ _id: workspaceId }, { $set: { "apps.insights.nextRunAt": enabled ? new Date() : null } });
}

async function runOne(workspaceId: string) {
  const digest = await generateDigest(workspaceId);
  await Workspace.updateOne({ _id: workspaceId }, { $set: { "apps.insights.nextRunAt": nextRunAfter(new Date()) } });
  if (digest.insights.length)
    await emit({
      type: "insights.ready",
      workspaceId,
      data: { count: digest.insights.length },
      link: "/app/insights",
    });
}

export async function runDueInsights(): Promise<{ generated: number; failed: number; errors: string[] }> {
  const due = await Workspace.find({ "apps.insights.enabled": true, "apps.insights.nextRunAt": { $lte: new Date() } })
    .sort({ "apps.insights.nextRunAt": 1 })
    .limit(CRON_BATCH)
    .select("_id")
    .lean();

  let generated = 0;
  let failed = 0;
  const errors: string[] = [];
  for (let i = 0; i < due.length; i += CRON_CONCURRENCY) {
    const slice = due.slice(i, i + CRON_CONCURRENCY);
    const results = await Promise.allSettled(slice.map((w) => runOne(String(w._id))));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") generated += 1;
      else {
        failed += 1;
        errors.push(`${slice[j]._id}: ${(r.reason as Error)?.message ?? "failed"}`);
      }
    });
  }
  return { generated, failed, errors };
}
