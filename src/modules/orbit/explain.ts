/**
 * "Why did this change?" — a short, purpose-built explanation of one metric's
 * move over the range the dashboard is already showing.
 *
 * Deliberately not routed through `workspaceDataDigest`: that digest is a
 * fixed, multi-site, always-the-same-metrics summary built for chat. This
 * wants one metric, one site, the caller's own current range, with the full
 * breakdown context (top pages/referrers/devices/countries) available to
 * explain *why* — so it calls `computeStats` directly, the same way the
 * dashboard's own stats route does.
 */

import { computeStats, resolveWindow, parseCompareMode } from "../analytics/stats.service.js";
import { askOrbit } from "./ask.js";
import type { OrbitHost } from "./types.js";

export type ExplainMetric =
  | "visitors"
  | "pageviews"
  | "sessions"
  | "bounceRate"
  | "avgSessionMs"
  | "avgTimeOnPageMs"
  | "pagesPerSession";

const METRIC_LABELS: Record<ExplainMetric, string> = {
  visitors: "Visitors",
  pageviews: "Pageviews",
  sessions: "Sessions",
  bounceRate: "Bounce rate",
  avgSessionMs: "Average session duration",
  avgTimeOnPageMs: "Average time on page",
  pagesPerSession: "Pages per session",
};

export type ExplainMetricInput = {
  siteId: string;
  metric: ExplainMetric;
  rangeKey: string;
  from?: unknown;
  to?: unknown;
  compare?: unknown;
  compareFrom?: unknown;
  compareTo?: unknown;
  /** The host driving quota/tier for the model chain — not spent here, only
   * consulted for entitlement (which models are eligible). */
  host: OrbitHost;
  tenantId: string;
  signal?: AbortSignal;
};

export type ExplainMetricResult = { ok: true; reply: string } | { ok: false; status: number; error: string };

function formatValue(metric: ExplainMetric, value: number): string {
  if (metric === "bounceRate") return `${value}%`;
  if (metric === "avgSessionMs" || metric === "avgTimeOnPageMs") {
    const seconds = Math.round(value / 1000);
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  if (metric === "pagesPerSession") return value.toFixed(1);
  return String(Math.round(value));
}

function rowsLine(label: string, rows: { key: string; count: number }[] | undefined): string {
  const top = (rows ?? []).slice(0, 5).filter((r) => r.key);
  if (!top.length) return "";
  return `${label}: ${top.map((r) => `${r.key} (${r.count})`).join(", ")}`;
}

export async function explainMetricChange(input: ExplainMetricInput): Promise<ExplainMetricResult> {
  const win = resolveWindow(
    input.rangeKey,
    input.from,
    input.to,
    parseCompareMode(input.compare),
    input.compareFrom,
    input.compareTo,
  );

  const stats = await computeStats([input.siteId], input.rangeKey, undefined, win);

  const label = METRIC_LABELS[input.metric];
  const rawValue = (stats as Record<string, unknown>)[input.metric];
  const value = typeof rawValue === "number" ? rawValue : null;
  if (value === null) {
    return { ok: false, status: 400, error: "That metric isn't available for this site." };
  }

  const deltas = (stats as { deltas?: Record<string, number | null> }).deltas ?? {};
  const deltaPct = deltas[input.metric];
  const deltaLine =
    deltaPct === null || deltaPct === undefined || !Number.isFinite(deltaPct)
      ? "No prior period to compare."
      : `Change: ${deltaPct >= 0 ? "+" : ""}${Math.round(deltaPct)}% vs the previous equal period.`;

  const rangeLabel = win.rangeKey === "custom"
    ? `${win.since.toDateString()} to ${win.until.toDateString()}`
    : input.rangeKey;

  const systemPrompt = [
    "You are explaining one analytics metric's change to the person looking at their own dashboard.",
    `Metric: ${label}.`,
    `Range: ${rangeLabel}.`,
    `Current value: ${formatValue(input.metric, value)}.`,
    deltaLine,
    rowsLine("Top pages this period", (stats as { topPages?: { key: string; count: number }[] }).topPages),
    rowsLine("Top referrers", (stats as { topReferrers?: { key: string; count: number }[] }).topReferrers),
    rowsLine("Devices", (stats as { devices?: { key: string; count: number }[] }).devices),
    rowsLine("Countries", (stats as { countries?: { key: string; count: number }[] }).countries),
    "",
    "In 2-4 sentences, plain language, explain what likely drove this change using only the data above.",
    "No chart suggestions, no causes outside this data. If the data doesn't clearly explain it, say so plainly.",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await askOrbit("Explain this change.", {
    systemPrompt,
    host: input.host,
    tenantId: input.tenantId,
    rawOutput: true,
    budgetMs: 20_000,
    attemptMs: 10_000,
    signal: input.signal,
  });

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }

  return { ok: true, reply: result.reply };
}
