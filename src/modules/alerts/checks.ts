import { Event } from "../analytics/models/Event.js";
import { workspaceTargets } from "../dashboards/goal-targets.service.js";
import type { AlertConfig, AlertRule } from "./rules.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DROP_MIN_BASELINE = 50;
const SPIKE_MIN_BASELINE = 20;
const SILENCE_LOOKBACK_MS = 7 * DAY_MS;
const GOAL_MIN_ELAPSED = 0.33;

export type AlertNotification = { type: "alert.triggered" | "tracking.stopped"; data: Record<string, unknown> };

export type AlertCondition = {
  key: string;
  rule: AlertRule;
  title: string;
  summary: string;
  siteId: string;
  link: string;
  notification: AlertNotification;
};

export type AlertSite = { siteId: string; name: string };

export type CheckContext = {
  workspaceId: string;
  config: AlertConfig;
  sites: AlertSite[];
  goalsOn: boolean;
  lastFormSubmissionAt: Date | null;
  now: Date;
};

const fmt = (n: number) => n.toLocaleString("en-US");

function condition(
  key: string,
  rule: AlertRule,
  title: string,
  summary: string,
  link: string,
  siteId = "",
  extra: Record<string, unknown> = {},
): AlertCondition {
  return {
    key,
    rule,
    title,
    summary,
    siteId,
    link,
    notification: { type: "alert.triggered", data: { rule, title, summary, ...extra } },
  };
}

function countPageviews(siteId: string, start: Date, end: Date): Promise<number> {
  return Event.countDocuments({ siteId, type: "pageview", ts: { $gte: start, $lt: end } });
}

async function trafficConditions(ctx: CheckContext, site: AlertSite): Promise<AlertCondition[]> {
  const { trafficDrop, trafficSpike } = ctx.config.rules;
  if (!trafficDrop.enabled && !trafficSpike.enabled) return [];

  const end = ctx.now.getTime();
  const [current, baseline] = await Promise.all([
    countPageviews(site.siteId, new Date(end - DAY_MS), new Date(end)),
    countPageviews(site.siteId, new Date(end - 8 * DAY_MS), new Date(end - 7 * DAY_MS)),
  ]);
  if (!baseline) return [];

  const change = Math.round(((current - baseline) / baseline) * 100);
  const compared = `${fmt(current)} pageviews in the last 24 hours, against ${fmt(baseline)} at the same time last week.`;
  const extra = { siteName: site.name, current, baseline, change };

  if (trafficDrop.enabled && baseline >= DROP_MIN_BASELINE && -change >= trafficDrop.value) {
    return [
      condition(`trafficDrop:${site.siteId}`, "trafficDrop", `Traffic down ${-change}% on ${site.name}`, compared, "/app/analytics", site.siteId, extra),
    ];
  }
  if (trafficSpike.enabled && baseline >= SPIKE_MIN_BASELINE && change >= trafficSpike.value) {
    return [
      condition(`trafficSpike:${site.siteId}`, "trafficSpike", `Traffic up ${change}% on ${site.name}`, compared, "/app/analytics", site.siteId, extra),
    ];
  }
  return [];
}

async function silenceConditions(ctx: CheckContext, site: AlertSite): Promise<AlertCondition[]> {
  const rule = ctx.config.rules.trackingStopped;
  if (!rule.enabled) return [];

  const now = ctx.now.getTime();
  const last = await Event.findOne({ siteId: site.siteId, ts: { $gte: new Date(now - SILENCE_LOOKBACK_MS) } })
    .sort({ ts: -1 })
    .select("ts")
    .lean<{ ts: Date }>();
  if (!last) return [];

  const hoursSilent = Math.floor((now - last.ts.getTime()) / HOUR_MS);
  if (hoursSilent < rule.value) return [];

  return [
    {
      key: `trackingStopped:${site.siteId}`,
      rule: "trackingStopped",
      title: `${site.name} stopped sending data`,
      summary: `No events for ${hoursSilent} hours. Check that the tracking script is still on the site.`,
      siteId: site.siteId,
      link: "/app/analytics",
      notification: { type: "tracking.stopped", data: { siteName: site.name, hoursSilent } },
    },
  ];
}

async function goalConditions(ctx: CheckContext): Promise<AlertCondition[]> {
  const rule = ctx.config.rules.goalBehind;
  if (!rule.enabled || !ctx.goalsOn) return [];

  const targets = await workspaceTargets(ctx.workspaceId);
  return targets.flatMap((t) => {
    if (t.status !== "ok" || t.achieved || t.direction !== "above" || t.projected === null) return [];
    if (t.elapsed < GOAL_MIN_ELAPSED) return [];
    const shortfall = Math.round((1 - t.projected / t.target) * 100);
    if (shortfall < rule.value) return [];
    return [
      condition(
        `goalBehind:${t.id}:${t.periodKey}`,
        "goalBehind",
        `“${t.name}” is ${shortfall}% behind pace`,
        `On course for ${fmt(t.projected)} of ${fmt(t.target)} by the end of ${t.periodLabel}.`,
        "/app/goals",
        t.siteId,
        { goalName: t.name, shortfall },
      ),
    ];
  });
}

function formsConditions(ctx: CheckContext): AlertCondition[] {
  const rule = ctx.config.rules.formsQuiet;
  const last = ctx.lastFormSubmissionAt;
  if (!rule.enabled || !last) return [];

  const days = Math.floor((ctx.now.getTime() - last.getTime()) / DAY_MS);
  if (days < rule.value) return [];

  const since = last.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return [
    condition(
      "formsQuiet",
      "formsQuiet",
      `No form submissions for ${days} days`,
      `Your lead capture forms have not had a response since ${since}. Check that they are still live and reachable.`,
      "/app/lead-capture",
      "",
      { days },
    ),
  ];
}

export async function evaluateAlerts(ctx: CheckContext): Promise<AlertCondition[]> {
  const groups = await Promise.all([
    ...ctx.sites.flatMap((site) => [trafficConditions(ctx, site), silenceConditions(ctx, site)]),
    goalConditions(ctx),
    Promise.resolve(formsConditions(ctx)),
  ]);
  return groups.flat();
}
