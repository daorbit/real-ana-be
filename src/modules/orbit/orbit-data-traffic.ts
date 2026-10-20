import { computeStats, resolveWindow } from "../analytics/stats.service.js";
import type { ParsedQuestionRange } from "./date-range.js";

const TOP_N = 5;
const MAX_TREND_POINTS = 31;

export type Row = { key: string; count: number };

export type OrbitDataDigestSite = {
  domain: string;
  visitors: number;
  visitorsChangePct: number | null;
  pageviews: number;
  pageviewsChangePct: number | null;
  sessions: number;
  sessionsChangePct: number | null;
  bounceRate: number;
  bounceRateChangePct: number | null;
  live: number;
  avgSessionSeconds: number;
  pagesPerSession: number;
  topPages: Row[];
  topReferrers: Row[];
  channels: Row[];
  countries: Row[];
  devices: Row[];
};

export type SiteTraffic = { prose: string; digest: OrbitDataDigestSite };

function top(rows: unknown): Row[] {
  return ((rows as Row[]) ?? []).filter((r) => r?.key).slice(0, TOP_N);
}

function changePct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function signed(pct: number | null, previous: number | string): string {
  if (pct === null) return " (no traffic in the previous period, so no comparison)";
  return ` (${pct >= 0 ? "+" : ""}${pct}% vs ${previous} in the previous period)`;
}

function list(label: string, rows: Row[]): string {
  return rows.length ? `${label}: ${rows.map((r) => `${r.key} (${r.count})`).join(", ")}` : "";
}

function trendLine(points: { bucket: string; views: number; visitors: number }[], hourly: boolean): string {
  if (points.length < 2) return "";
  const shown = points.slice(-MAX_TREND_POINTS);
  const unit = hourly ? "Hourly (UTC)" : "Daily (UTC, MM-DD)";
  return `${unit} pageviews/visitors: ${shown.map((p) => `${p.bucket} ${p.views}/${p.visitors}`).join("; ")}`;
}

export async function siteTraffic(
  site: { siteId: string; domain: string },
  range: ParsedQuestionRange,
  win: ReturnType<typeof resolveWindow>,
): Promise<SiteTraffic> {
  const stats = await computeStats([site.siteId], range.rangeKey, undefined, win);
  const prev = stats.comparison;

  const digest: OrbitDataDigestSite = {
    domain: site.domain,
    visitors: stats.visitors,
    visitorsChangePct: changePct(stats.visitors, prev.visitors),
    pageviews: stats.pageviews,
    pageviewsChangePct: changePct(stats.pageviews, prev.pageviews),
    sessions: stats.sessions,
    sessionsChangePct: changePct(stats.sessions, prev.sessions),
    bounceRate: stats.bounceRate,
    bounceRateChangePct: changePct(stats.bounceRate, prev.bounceRate),
    live: stats.live,
    avgSessionSeconds: Math.round((stats.avgSessionMs ?? 0) / 1000),
    pagesPerSession: Math.round((stats.pagesPerSession ?? 0) * 10) / 10,
    topPages: top(stats.topPages),
    topReferrers: top(stats.topReferrers),
    channels: top(stats.channels),
    countries: top(stats.countries),
    devices: top(stats.devices),
  };

  const prose = [
    `Site ${site.domain} — ${range.label}:`,
    `Visitors: ${digest.visitors}${signed(digest.visitorsChangePct, prev.visitors)}`,
    `Pageviews: ${digest.pageviews}${signed(digest.pageviewsChangePct, prev.pageviews)}`,
    `Sessions: ${digest.sessions}${signed(digest.sessionsChangePct, prev.sessions)}`,
    `Bounce rate: ${digest.bounceRate}%${signed(digest.bounceRateChangePct, `${prev.bounceRate}%`)}`,
    `Average session: ${digest.avgSessionSeconds}s, ${digest.pagesPerSession} pages per session`,
    `Visitors online now: ${digest.live}`,
    trendLine(stats.timeseries ?? [], win.windowMs <= 24 * 60 * 60 * 1000),
    list("Top pages (pageviews)", digest.topPages),
    list("Entry pages (sessions)", top(stats.entryPages)),
    list("Channels (sessions)", digest.channels),
    list("Referrers (sessions)", digest.topReferrers),
    list("UTM sources (sessions)", top(stats.utmSources)),
    list("Countries (pageviews)", digest.countries),
    list("Devices (pageviews)", digest.devices),
  ]
    .filter(Boolean)
    .join("\n");

  return { prose, digest };
}
