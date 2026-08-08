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
 */

import { Site } from "../models/Site.js";
import { computeStats } from "../stats-core.js";

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
    ].filter(Boolean);

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
