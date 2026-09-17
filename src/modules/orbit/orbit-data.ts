
import { Site } from "../analytics/models/Site.js";
import { computeStats, resolveWindow } from "../analytics/stats.service.js";
import { parseQuestionRange } from "./date-range.js";
import { SeoReport } from "../seo/models/SeoReport.js";
import { Competitor } from "../seo/models/Competitor.js";
import { snapshotFromReport, type CompareSnapshot } from "../seo/competitor.js";
import { compareSnapshots } from "../seo/competitor-analysis.js";

/** Rows per breakdown. Enough to spot a pattern, short enough to stay in budget. */
const TOP_N = 5;

/** How many of the workspace's sites to summarise. */
const MAX_SITES = 2;

type Row = { key: string; count: number };

function topList(label: string, rows: Row[] | undefined): string {
  const top = (rows ?? []).slice(0, TOP_N).filter((r) => r.key);
  if (!top.length) return "";
  return `${label}: ${top.map((r) => `${r.key} (${r.count})`).join(", ")}`;
}


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
  topPages: Row[];
  topReferrers: Row[];
  countries: Row[];
  devices: Row[];
};

export type OrbitDataDigest = {
  sites: OrbitDataDigestSite[];
  /** Human-readable range the figures cover, e.g. "the last 7 days" or "last
   * month" — echoed so the table's caption matches what was actually asked. */
  rangeLabel?: string;
};

/** A delta as a signed percentage, or nothing when there is no prior period to compare. */
function change(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const rounded = Math.round(value);
  return ` (${rounded >= 0 ? "+" : ""}${rounded}% vs previous period)`;
}

/** Competitors summarised per site. More than this and the digest crowds out the rest. */
const MAX_COMPETITORS_SUMMARISED = 3;

const MAX_RECOMMENDATIONS = 3;


async function seoSummary(siteId: string): Promise<string> {
  const report = await SeoReport.findOne({ siteId }).sort({ createdAt: -1 });
  if (!report?.get("data")) return "";

  const data = report.get("data") as Parameters<typeof snapshotFromReport>[0] & {
    issues?: { severity: string; title: string }[];
  };

  const lines: string[] = [`SEO score: ${report.get("score") ?? "unknown"}/100`];

  const critical = (data.issues ?? []).filter((i) => i.severity === "critical");
  if (critical.length) {
    lines.push(
      `Critical issues (${critical.length}): ${critical.slice(0, 5).map((i) => i.title).join("; ")}`
    );
  }

  const competitors = await Competitor.find({ siteId })
    .sort({ createdAt: 1 })
    .limit(MAX_COMPETITORS_SUMMARISED);

  const tracked = competitors.filter((c) => c.get("snapshot"));
  if (tracked.length) {
    const mine = snapshotFromReport(data);

    for (const competitor of tracked) {
      const snapshot = competitor.get("snapshot") as CompareSnapshot;
      const gap = compareSnapshots(mine, snapshot);
      const label = competitor.get("label") || competitor.get("url");

      // The sign is stated in words as well as arithmetic: "gap: -8" reads
      // ambiguously to a model, and a wrong reading inverts the advice.
      const standing =
        gap.scoreGap > 0
          ? `they lead by ${gap.scoreGap}`
          : gap.scoreGap < 0
          ? `you lead by ${Math.abs(gap.scoreGap)}`
          : "level";

      lines.push(
        `Competitor ${label} — on-page ${snapshot.score}/100 vs your ${mine.score} (${standing}).`
      );

      if (gap.contentGaps.length)
        lines.push(`  Sections they cover that you do not: ${gap.contentGaps.slice(0, 4).join("; ")}`);
      if (gap.missingSchemaTypes.length)
        lines.push(`  Schema they declare and you do not: ${gap.missingSchemaTypes.join(", ")}`);
      if (gap.missingKeywords.length)
        lines.push(`  Prominent terms on their page, absent from yours: ${gap.missingKeywords.slice(0, 6).join(", ")}`);

      for (const rec of gap.recommendations.slice(0, MAX_RECOMMENDATIONS)) {
        lines.push(`  - ${rec}`);
      }
    }
  }

  return lines.join("\n");
}


export async function workspaceDataSummary(workspaceId: string, question?: string): Promise<string> {
  const sites = await Site.find({ workspaceId }).select("siteId domain").limit(MAX_SITES);
  if (!sites.length) return "";

  const { rangeKey, from, to, label } = parseQuestionRange(question ?? "");

  const blocks: string[] = [];

  for (const site of sites) {
    const stats = await computeStats([site.siteId as string], rangeKey, undefined, resolveWindow(rangeKey, from, to));

    const lines = [
      `Site ${site.domain} — ${label}:`,
      `Visitors: ${stats.visitors}${change(stats.deltas?.visitors)}`,
      `Pageviews: ${stats.pageviews}${change(stats.deltas?.pageviews)}`,
      `Sessions: ${stats.sessions}${change(stats.deltas?.sessions)}`,
      `Bounce rate: ${stats.bounceRate}%${change(stats.deltas?.bounceRate)}`,
      `Visitors online now: ${stats.live}`,
      topList("Top pages", stats.topPages as Row[]),
      topList("Top referrers", stats.topReferrers as Row[]),
      topList("Top countries", stats.countries as Row[]),
      topList("Devices", stats.devices as Row[]),
      // Appended to the same site block rather than kept in a section of its
      // own, so a model reading about acme.com sees its traffic and its
      // competitive standing as one subject.
      await seoSummary(site.siteId as string),
    ].filter(Boolean);

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}


export async function workspaceDataDigest(workspaceId: string, question?: string): Promise<OrbitDataDigest> {
  const sites = await Site.find({ workspaceId }).select("siteId domain").limit(MAX_SITES);
  if (!sites.length) return { sites: [] };

  const { rangeKey, from, to, label } = parseQuestionRange(question ?? "");

  const digest: OrbitDataDigestSite[] = [];

  for (const site of sites) {
    const stats = await computeStats([site.siteId as string], rangeKey, undefined, resolveWindow(rangeKey, from, to));

    digest.push({
      domain: site.domain as string,
      visitors: stats.visitors,
      visitorsChangePct: stats.deltas?.visitors ?? null,
      pageviews: stats.pageviews,
      pageviewsChangePct: stats.deltas?.pageviews ?? null,
      sessions: stats.sessions,
      sessionsChangePct: stats.deltas?.sessions ?? null,
      bounceRate: stats.bounceRate,
      bounceRateChangePct: stats.deltas?.bounceRate ?? null,
      live: stats.live,
      topPages: ((stats.topPages as Row[]) ?? []).slice(0, TOP_N).filter((r) => r.key),
      topReferrers: ((stats.topReferrers as Row[]) ?? []).slice(0, TOP_N).filter((r) => r.key),
      countries: ((stats.countries as Row[]) ?? []).slice(0, TOP_N).filter((r) => r.key),
      devices: ((stats.devices as Row[]) ?? []).slice(0, TOP_N).filter((r) => r.key),
    });
  }

  return { sites: digest, rangeLabel: label };
}
