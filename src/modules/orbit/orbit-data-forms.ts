import { readFormsWorkspace } from "../../infra/http-client/forms-service.js";
import type { Row } from "./orbit-data-traffic.js";

const ORBIT_ACTOR = "orbit";
const TOP_N = 5;
const UPCOMING_SHOWN = 3;
const LEAD_SOURCE_RANGES = new Set(["7d", "30d"]);

type Window = { since: Date; until: Date };

type FormList = {
  stats?: { totalForms: number; publishedForms: number; totalViews: number; totalSubmissions: number };
};
type Pipeline = {
  total: number;
  byStage: Record<string, number>;
  averageLeadScore: number | null;
  topForms: { name: string; leads: number }[];
};
type Bookings = {
  total: number;
  byForm: { name: string; bookings: number }[];
  upcoming: { formName: string; start: string }[];
};
type LeadSources = { sources: { source: string; count: number; won: number }[] };

export type OrbitLeadsDigest = {
  leads: number;
  leadsChangePct: number | null;
  byStage: Record<string, number>;
  averageLeadScore: number | null;
  topForms: Row[];
  bookings: number;
  upcomingBookings: number;
};

export type FormsData = { prose: string; digest: OrbitLeadsDigest };

function read<T>(workspaceId: string, path: string, params: Record<string, string | number | undefined> = {}) {
  return readFormsWorkspace<T>(workspaceId, ORBIT_ACTOR, path, params);
}

function asParams(w: Window) {
  return { from: w.since.toISOString(), to: w.until.toISOString() };
}

function changePct(current: number, previous: number | undefined): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function upcomingLine(upcoming: Bookings["upcoming"]): string {
  const next = upcoming.slice(0, UPCOMING_SHOWN);
  if (!next.length) return "Upcoming bookings: none scheduled";
  return `Next upcoming bookings (UTC): ${next.map((b) => `${new Date(b.start).toISOString().slice(0, 16).replace("T", " ")}${b.formName ? ` via ${b.formName}` : ""}`).join("; ")}`;
}

export async function formsData(
  workspaceId: string,
  current: Window,
  previous: Window,
  label: string,
  rangeKey: string,
): Promise<FormsData | null> {
  const [forms, pipeline, prevPipeline, bookings, sources] = await Promise.all([
    read<FormList>(workspaceId, "", { limit: 1 }),
    read<Pipeline>(workspaceId, "/pipeline-summary", asParams(current)),
    read<Pipeline>(workspaceId, "/pipeline-summary", asParams(previous)).catch(() => null),
    read<Bookings>(workspaceId, "/booking-summary", asParams(current)).catch(() => null),
    LEAD_SOURCE_RANGES.has(rangeKey)
      ? read<LeadSources>(workspaceId, "/lead-sources", { range: rangeKey }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const totals = forms.stats;
  if (!totals?.totalForms) return null;

  const leadsChangePct = changePct(pipeline.total, prevPipeline?.total);
  const topForms = pipeline.topForms.slice(0, TOP_N).map((f) => ({ key: f.name || "Untitled form", count: f.leads }));
  const stages = Object.entries(pipeline.byStage).map(([stage, count]) => `${stage} ${count}`).join(", ");
  const channels = (sources?.sources ?? []).slice(0, TOP_N);

  const prose = [
    `Forms and leads — ${label}:`,
    `Forms: ${totals.totalForms} (${totals.publishedForms} published); all time ${totals.totalViews} form views and ${totals.totalSubmissions} responses`,
    `New leads: ${pipeline.total}${
      leadsChangePct === null
        ? " (no leads in the previous period, so no comparison)"
        : ` (${leadsChangePct >= 0 ? "+" : ""}${leadsChangePct}% vs ${prevPipeline?.total} in the previous period)`
    }`,
    pipeline.total ? `Current pipeline stage of these leads: ${stages}` : "",
    pipeline.averageLeadScore !== null ? `Average lead score: ${pipeline.averageLeadScore}` : "",
    topForms.length ? `Forms producing the most leads: ${topForms.map((f) => `${f.key} (${f.count})`).join(", ")}` : "",
    channels.length
      ? `Lead channels: ${channels.map((c) => `${c.source || "Direct"} (${c.count} leads, ${c.won} won)`).join(", ")}`
      : "",
    bookings ? `Bookings in this window: ${bookings.total}` : "",
    bookings ? upcomingLine(bookings.upcoming) : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    prose,
    digest: {
      leads: pipeline.total,
      leadsChangePct,
      byStage: pipeline.byStage,
      averageLeadScore: pipeline.averageLeadScore,
      topForms,
      bookings: bookings?.total ?? 0,
      upcomingBookings: bookings?.upcoming.length ?? 0,
    },
  };
}
