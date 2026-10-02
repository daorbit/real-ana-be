import { askOrbit, type OrbitTurn } from "../orbit/ask.js";
import type { OrbitHost } from "../orbit/types.js";
import { extractJson } from "../forms-ai/generate.js";
import type { Placed } from "../workspace/layout.js";
import { DASHBOARD_RANGES, type DashboardRange } from "./models/Dashboard.js";
import { DASHBOARD_WIDGETS, DASHBOARD_WIDGET_MAP, type WidgetSpan } from "./widget-catalog.js";

export type DashboardDraft = {
  name: string;
  description: string;
  range: DashboardRange;
  layout: Placed[];
};

export type DashboardAiMode = "create" | "edit";

export type DashboardAiInput = {
  prompt: string;
  mode: DashboardAiMode;
  current?: DashboardDraft;
  history?: OrbitTurn[];
  host: OrbitHost;
  tenantId: string;
  signal?: AbortSignal;
};

export type DashboardAiResult =
  | { ok: true; reply: string; draft: DashboardDraft; suggestions: string[] }
  | { ok: false; status: number; error: string; quotaExceeded?: boolean };

export const MAX_DASHBOARD_PROMPT_CHARS = 800;
const MAX_WIDGETS = 24;
const SPANS: WidgetSpan[] = [1, 2, 3, 4];

function catalog(): string {
  const groups = ["Metrics", "Charts", "Breakdowns", "Search"] as const;
  return groups
    .map((group) => {
      const rows = DASHBOARD_WIDGETS.filter((w) => w.group === group).map(
        (w) => `- ${w.id}: ${w.label}. ${w.description}. Default span ${w.span}.`,
      );
      return `${group}:\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

function systemPrompt(mode: DashboardAiMode, current?: DashboardDraft): string {
  const base = [
    "You are Orbit, the assistant inside Quantalog, an analytics product. You design analytics dashboards from a short description.",
    "Reply with one JSON object and nothing else: no prose around it, no code fence.",
    "",
    "Shape:",
    '{ "reply": string, "name": string, "description": string, "range": "24h" | "7d" | "30d", "layout": [ { "id": string, "span": 1 | 2 | 3 | 4 } ], "suggestions": string[] }',
    "",
    '- "reply": one or two short sentences to the person about what you built or changed and why. Plain text, no markdown.',
    '- "name": a short dashboard name, at most 40 characters.',
    '- "description": one sentence, at most 140 characters, on what the dashboard is for.',
    '- "range": the default date range that suits the purpose. Live monitoring is 24h, weekly reviews 7d, monthly or client reporting 30d.',
    '- "layout": the widgets in display order. The grid is 4 columns wide and "span" is how many columns a widget takes.',
    '- "suggestions": exactly 3 short follow-up requests the person could make next to refine this dashboard, each under 60 characters, written as instructions.',
    "",
    "Layout rules:",
    "- Use only widget ids from the catalog below, each at most once. Anything else is thrown away.",
    "- A new dashboard has between 6 and 14 widgets. Choose what answers the request and leave the rest out.",
    "- Headline numbers come first, in a row of 4 widgets with span 1. Then the main chart, then breakdowns.",
    "- Make the spans in each row add up to 4.",
    "- Search widgets read Google Search Console. Use them only when the request is about Google, SEO, rankings, keywords or organic search.",
    "",
    "Widget catalog:",
    catalog(),
  ];

  if (!current) return base.join("\n");

  const editing = [
    "",
    mode === "edit" ? "The dashboard as it is now, already in use:" : "The draft so far:",
    JSON.stringify(current),
    "",
    "The next message is a change to this dashboard. Reply with the whole dashboard again, not just the change.",
    "Keep every widget, its order and its span, and keep the name, description and range exactly as they are, unless the request is about them.",
    'If the message is a question rather than a change, answer it in "reply" and return the dashboard unchanged.',
  ];
  return [...base, ...editing].join("\n");
}

function readText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function readRange(raw: unknown): DashboardRange | undefined {
  return DASHBOARD_RANGES.includes(raw as DashboardRange) ? (raw as DashboardRange) : undefined;
}

function readLayout(raw: unknown): Placed[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const item of raw) {
    const id = typeof item === "string" ? item : (item as { id?: unknown })?.id;
    if (typeof id !== "string") continue;
    const widget = DASHBOARD_WIDGET_MAP.get(id);
    if (!widget || seen.has(id)) continue;
    seen.add(id);
    const span = Number((item as { span?: unknown })?.span);
    out.push({ id, span: SPANS.includes(span as WidgetSpan) ? span : widget.span });
    if (out.length >= MAX_WIDGETS) break;
  }
  return out;
}

function readSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => readText(s, 80))
    .filter(Boolean)
    .slice(0, 3);
}

export function parseDashboardDraft(raw: unknown): DashboardDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const layout = readLayout(body.layout);
  if (!layout) return undefined;
  return {
    name: readText(body.name, 80) || "Untitled dashboard",
    description: readText(body.description, 240),
    range: readRange(body.range) ?? "7d",
    layout,
  };
}

function shape(raw: unknown, current?: DashboardDraft): DashboardDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const layout = readLayout(body.layout) ?? current?.layout;
  if (!layout || (!current && layout.length === 0)) return null;
  return {
    name: readText(body.name, 80) || current?.name || "Untitled dashboard",
    description: readText(body.description, 240) || current?.description || "",
    range: readRange(body.range) ?? current?.range ?? "7d",
    layout,
  };
}

export async function designDashboard(input: DashboardAiInput): Promise<DashboardAiResult> {
  const prompt = input.prompt.trim().slice(0, MAX_DASHBOARD_PROMPT_CHARS);
  if (!prompt) return { ok: false, status: 400, error: "Describe the dashboard you want first." };

  const result = await askOrbit(prompt, {
    systemPrompt: systemPrompt(input.mode, input.current),
    history: input.history,
    host: input.host,
    tenantId: input.tenantId,
    rawOutput: true,
    budgetMs: 30_000,
    attemptMs: 15_000,
    signal: input.signal,
  });

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, quotaExceeded: result.quotaExceeded };
  }

  const parsed = extractJson(result.reply);
  const draft = shape(parsed, input.current);
  if (!draft) {
    console.error("[dashboard-ai] unusable reply —", result.reply.slice(0, 400));
    return {
      ok: false,
      status: 502,
      error: "Orbit couldn't shape a dashboard from that. Try describing what you want to keep an eye on.",
    };
  }

  const body = parsed as Record<string, unknown>;
  return {
    ok: true,
    reply: readText(body.reply, 600) || "Here's a layout for that.",
    draft,
    suggestions: readSuggestions(body.suggestions),
  };
}
