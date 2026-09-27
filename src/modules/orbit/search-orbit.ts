import {
  getSearchDrilldown,
  getSearchInsights,
  getSearchPerformance,
  type SiteRef,
} from "../seo/search-console.service.js";
import type { SearchType } from "../../infra/http-client/search-console.js";
import { askOrbit, type OrbitTurn } from "./ask.js";
import type { OrbitHost } from "./types.js";

export type SearchOrbitMode = "summary" | "metric" | "question";
export type SearchOrbitMetric = "clicks" | "impressions" | "ctr" | "position";

export const SEARCH_ORBIT_METRICS = new Set<SearchOrbitMetric>(["clicks", "impressions", "ctr", "position"]);

type Metrics = { clicks: number; impressions: number; ctr: number; position: number };

export type SearchOrbitInput = {
  site: SiteRef;
  days: number;
  type: SearchType;
  mode: SearchOrbitMode;
  metric?: SearchOrbitMetric;
  question?: string;
  history?: OrbitTurn[];
  pageUrl?: string;
  host: OrbitHost;
  tenantId: string;
  signal?: AbortSignal;
};

export type SearchOrbitResult =
  | { ok: true; reply: string }
  | { ok: false; status: number; error: string; quotaExceeded?: boolean };

const METRIC_LABELS: Record<SearchOrbitMetric, string> = {
  clicks: "Clicks",
  impressions: "Impressions",
  ctr: "Click-through rate",
  position: "Average position",
};

function fmt(metric: SearchOrbitMetric, value: number): string {
  if (metric === "ctr") return `${(value * 100).toFixed(1)}%`;
  if (metric === "position") return value ? value.toFixed(1) : "n/a";
  return String(Math.round(value));
}

function metricsLine(label: string, current: Metrics, previous: Metrics | null): string {
  const parts = (Object.keys(METRIC_LABELS) as SearchOrbitMetric[]).map((m) => {
    const now = fmt(m, current[m]);
    return previous ? `${METRIC_LABELS[m]} ${now} (previous ${fmt(m, previous[m])})` : `${METRIC_LABELS[m]} ${now}`;
  });
  return `${label}: ${parts.join("; ")}.`;
}

function rowLine(row: { key: string } & Partial<Metrics> & { previousClicks?: number | null; views?: number }) {
  const bits = [
    row.clicks !== undefined ? `${Math.round(row.clicks)} clicks` : "",
    row.previousClicks !== undefined && row.previousClicks !== null ? `was ${Math.round(row.previousClicks)}` : "",
    row.impressions !== undefined ? `${Math.round(row.impressions)} impressions` : "",
    row.ctr !== undefined ? `CTR ${(row.ctr * 100).toFixed(1)}%` : "",
    row.position ? `position ${row.position.toFixed(1)}` : "",
    row.views !== undefined ? `${row.views} site views` : "",
  ].filter(Boolean);
  return `- ${row.key}: ${bits.join(", ")}`;
}

function section(title: string, rows: string[]): string {
  return rows.length ? `${title}:\n${rows.join("\n")}` : `${title}: none.`;
}

async function siteDigest(site: SiteRef, days: number, type: SearchType): Promise<string> {
  const [performance, insights] = await Promise.all([
    getSearchPerformance(site, days, type),
    getSearchInsights(site, days, type),
  ]);

  return [
    `Google Search data for ${site.propertyUrl}, ${type} search, last ${days} days (${performance.startDate} to ${performance.endDate}), compared with the ${days} days before.`,
    metricsLine("Site totals", performance.totals, performance.previous),
    `Queries with impressions: ${insights.counts.queries}. Pages with impressions: ${insights.counts.pages}. New queries: ${insights.counts.newQueries}. Lost queries: ${insights.counts.lostQueries}.`,
    section("Top queries", performance.queries.map((q) => rowLine({ key: q.query, ...q }))),
    section("Top pages", performance.pages.map((p) => rowLine({ key: p.page, ...p }))),
    section("Quick wins (position 4-20, real demand)", insights.quickWins.slice(0, 5).map(rowLine)),
    section("Low click-through on page 1", insights.lowCtr.slice(0, 5).map(rowLine)),
    section("Rising queries", insights.risingQueries.slice(0, 5).map(rowLine)),
    section("Falling queries", insights.fallingQueries.slice(0, 5).map(rowLine)),
    section("Rising pages", insights.risingPages.slice(0, 5).map(rowLine)),
    section("Falling pages", insights.fallingPages.slice(0, 5).map(rowLine)),
    section("Lost queries", insights.lostQueries.slice(0, 5).map((r) => `- ${r.key}: had ${r.previousClicks} clicks, now none`)),
  ].join("\n\n");
}

async function pageDigest(site: SiteRef, url: string, days: number, type: SearchType): Promise<string> {
  const page = await getSearchDrilldown(site, "page", url, days, type);
  return [
    `Google Search data for the page ${url}, ${type} search, last ${days} days, compared with the ${days} days before.`,
    metricsLine("Page totals", page.totals, page.previous),
    page.views
      ? `Site views tracked by Quantalog for this page (all sources): ${page.views.total} (previous ${page.views.previous}).`
      : "",
    section("Queries bringing people to this page", page.related.slice(0, 15).map(rowLine)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const RULES = [
  "You are Orbit, helping someone understand their own Google Search Console data inside Quantalog.",
  "Use only the data below. Never invent numbers, queries or pages. If the data can't answer something, say so plainly.",
  "Clicks and impressions are counts; a lower position number is better (1 is the top result).",
  "Be concrete: name the actual queries and pages, and give specific, practical SEO actions.",
].join(" ");

function task(input: SearchOrbitInput): { prompt: string; question: string } {
  if (input.mode === "metric" && input.metric) {
    const label = METRIC_LABELS[input.metric];
    return {
      question: `Why did ${label.toLowerCase()} change?`,
      prompt: `Explain the change in ${label} in 2-4 plain sentences, pointing at the queries or pages in the data that most likely drove it. No headings.`,
    };
  }
  if (input.mode === "summary") {
    return {
      question: "Summarise my search performance.",
      prompt:
        "Give a short read of this performance: 3 to 5 bullet points covering what changed and the likely reason, then 1 or 2 bullets starting with 'Next:' for the most valuable action. Keep each bullet to one or two sentences.",
    };
  }
  return {
    question: (input.question ?? "").slice(0, 800),
    prompt: "Answer the question concisely. Use short bullet points when listing several items.",
  };
}

export async function askSearchOrbit(input: SearchOrbitInput): Promise<SearchOrbitResult> {
  const digest = input.pageUrl
    ? await pageDigest(input.site, input.pageUrl, input.days, input.type)
    : await siteDigest(input.site, input.days, input.type);

  const { prompt, question } = task(input);
  if (!question.trim()) return { ok: false, status: 400, error: "Ask a question first." };

  const result = await askOrbit(question, {
    systemPrompt: [RULES, prompt, "", digest].join("\n"),
    history: input.mode === "question" ? input.history : undefined,
    host: input.host,
    tenantId: input.tenantId,
    rawOutput: true,
    budgetMs: 25_000,
    attemptMs: 12_000,
    signal: input.signal,
  });

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, quotaExceeded: result.quotaExceeded };
  }
  return { ok: true, reply: result.reply };
}
