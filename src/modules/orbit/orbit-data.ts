import { Site } from "../analytics/models/Site.js";
import { resolveWindow } from "../analytics/stats.service.js";
import { parseQuestionRange } from "./date-range.js";
import { SeoReport } from "../seo/models/SeoReport.js";
import type { snapshotFromReport } from "../seo/competitor.js";
import { competitorAnalysis } from "../seo/compare-analysis.service.js";
import { reviewsSummaryFor } from "./orbit-data-reviews.js";
import { siteTraffic, type OrbitDataDigestSite } from "./orbit-data-traffic.js";
import { formsData, type OrbitLeadsDigest } from "./orbit-data-forms.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";

const MAX_SITES = 2;
const DATA_TTL_MS = 15_000;

export type OrbitDataDigest = {
  sites: OrbitDataDigestSite[];
  rangeLabel?: string;
  leads?: OrbitLeadsDigest;
};

type WorkspaceData = { summary: string; digest: OrbitDataDigest };

const dataCache = createTtlCache<WorkspaceData>(DATA_TTL_MS, 500);

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

  const analysis = await competitorAnalysis(siteId, MAX_COMPETITORS_SUMMARISED);
  if (analysis) {
    const mine = analysis.mine;

    for (const entry of analysis.competitors) {
      const label = entry.label || entry.url;
      if (entry.readIssue) {
        lines.push(`Competitor ${label} — page could not be read (blocked or error), so it is not compared.`);
        continue;
      }
      const { snapshot, gap } = entry;

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

function conversionLine(visitors: number, leads: number): string {
  if (!visitors) return "";
  const pct = Math.round((leads / visitors) * 1000) / 10;
  return `Lead conversion: ${leads} leads from ${visitors} website visitors (${pct}%) in the same window.`;
}

async function buildWorkspaceData(workspaceId: string, question: string): Promise<WorkspaceData> {
  const range = parseQuestionRange(question);
  const win = resolveWindow(range.rangeKey, range.from, range.to);

  const [sites, business, forms] = await Promise.all([
    Site.find({ workspaceId }).select("siteId domain").limit(MAX_SITES + 1).lean(),
    reviewsSummaryFor(workspaceId).catch(() => ""),
    formsData(
      workspaceId,
      { since: win.since, until: win.until },
      { since: win.prevSince, until: win.prevUntil },
      range.label,
      range.rangeKey,
    ).catch(() => null),
  ]);

  const shown = sites.slice(0, MAX_SITES).map((s) => ({ siteId: s.siteId as string, domain: s.domain as string }));
  const perSite = await Promise.all(
    shown.map(async (site) => {
      const [traffic, seo] = await Promise.all([
        siteTraffic(site, range, win),
        seoSummary(site.siteId).catch(() => ""),
      ]);
      return { traffic, seo };
    }),
  );

  const blocks = perSite.map(({ traffic, seo }) => [traffic.prose, seo].filter(Boolean).join("\n"));
  if (sites.length > MAX_SITES) {
    blocks.push(`This workspace tracks more than ${MAX_SITES} sites; only the first ${MAX_SITES} are summarised above.`);
  }
  if (forms) {
    blocks.push(forms.prose);
    if (sites.length && sites.length <= MAX_SITES) {
      const visitors = perSite.reduce((sum, p) => sum + p.traffic.digest.visitors, 0);
      const line = conversionLine(visitors, forms.digest.leads);
      if (line) blocks.push(line);
    }
  }
  if (business) blocks.push(business);

  return {
    summary: blocks.join("\n\n"),
    digest: {
      sites: perSite.map((p) => p.traffic.digest),
      rangeLabel: range.label,
      ...(forms ? { leads: forms.digest } : {}),
    },
  };
}

function workspaceData(workspaceId: string, question = ""): Promise<WorkspaceData> {
  const range = parseQuestionRange(question);
  return dataCache(`${workspaceId}:${range.rangeKey}:${range.label}`, () => buildWorkspaceData(workspaceId, question));
}

export async function workspaceDataSummary(workspaceId: string, question?: string): Promise<string> {
  return (await workspaceData(workspaceId, question)).summary;
}

export async function workspaceDataDigest(workspaceId: string, question?: string): Promise<OrbitDataDigest> {
  return (await workspaceData(workspaceId, question)).digest;
}
