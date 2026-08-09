/**
 * The workspace summary Orbit is allowed to answer from, on plans that include
 * data access.
 *
 * Deliberately a small, fixed digest rather than a query interface. Orbit is a
 * support assistant, and the questions data access exists to answer — "why is
 * traffic down", "which page lost visitors" — are all answered by headline
 * totals, their change against the previous period, and a handful of top rows.
 * Handing a model the ability to ask arbitrary questions of the event
 * collection would be a much larger feature with a much larger blast radius,
 * and none of it is needed to answer those.
 *
 * What is *not* here matters as much as what is. No visitor hashes, no IPs, no
 * per-event rows, nothing that identifies a person: this text is sent to a
 * third-party model, so it carries aggregates only. A model provider receiving
 * "/pricing had 412 views" is a different thing from one receiving a visitor
 * log, and only the first is defensible on a support feature.
 *
 * The digest also carries the site's SEO standing and how it compares to any
 * tracked competitors, which is what lets Orbit answer "how do we beat them"
 * from real gaps rather than generic advice. That data is of a different kind
 * but the same sensitivity: the workspace's own audit findings, and public
 * page content already fetched from competitor sites. Still no visitor data.
 */

import { Site } from "../analytics/models/Site.js";
import { computeStats } from "../analytics/stats.service.js";
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

/** A delta as a signed percentage, or nothing when there is no prior period to compare. */
function change(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const rounded = Math.round(value);
  return ` (${rounded >= 0 ? "+" : ""}${rounded}% vs previous period)`;
}

/** Competitors summarised per site. More than this and the digest crowds out the rest. */
const MAX_COMPETITORS_SUMMARISED = 3;

/** Gap bullets carried per competitor, highest-value first. */
const MAX_RECOMMENDATIONS = 3;

/**
 * The SEO standing for one site: your latest audit, and how you compare to the
 * competitors tracked against it.
 *
 * This is what lets Orbit answer "how do we beat them" with the actual gaps
 * rather than generic advice. The comparison is the same `compareSnapshots`
 * the Compare page draws, so Orbit cannot quote a different verdict than the
 * one on screen.
 *
 * Everything here is either the workspace's own audit or public page content
 * fetched from a competitor's site. No visitor data of any kind.
 */
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

/**
 * A plain-text digest of one workspace's last 7 days, or empty when there is
 * nothing to report.
 *
 * Returns "" rather than a "no data" sentence when the workspace tracks no
 * sites: an empty string leaves the base prompt's "you cannot read their
 * analytics" rule in force, which is the honest answer when there is genuinely
 * nothing to read.
 */
export async function workspaceDataSummary(workspaceId: string): Promise<string> {
  const sites = await Site.find({ workspaceId }).select("siteId domain").limit(MAX_SITES);
  if (!sites.length) return "";

  const blocks: string[] = [];

  for (const site of sites) {
    // Seven days rather than the dashboard's default: a support question about
    // a trend needs enough window to show one, and 24h is mostly noise on a
    // small site.
    const stats = await computeStats([site.siteId as string], "7d");

    const lines = [
      `Site ${site.domain} — last 7 days:`,
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
