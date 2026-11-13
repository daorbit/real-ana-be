import { Types } from "mongoose";
import { StatusComponentState } from "./models/StatusComponentState.js";
import { StatusDay } from "./models/StatusDay.js";
import { StatusIncident } from "./models/StatusIncident.js";
import {
  IMPACT_STATE,
  STATUS_COMPONENTS,
  worst,
  type ComponentState,
  type IncidentImpact,
  type StatusComponentId,
} from "./components.js";
import { DAY_MS, dayBounds, dayKey, lastDays } from "./days.js";
import { presentIncident, type IncidentRow } from "./present.js";

const BAR_DAYS = 90;
const RECENT_DAYS = 14;
const HISTORY_PAGE = 20;
const CHECKS_PER_DAY = 288;
const JOBS_STALE_MS = 20 * 60 * 1000;
const JOBS_DOWN_MS = 60 * 60 * 1000;
const OUTAGE_CHECKS_FOR_RED = 6;

type DayState = ComponentState | "none";

type StateRow = { component: string; state: "operational" | "degraded" | "outage"; lastCheckedAt: Date | null };
type DayRow = { component: string; day: string; checks: number; degraded: number; outage: number };
type SpanRow = { impact: IncidentImpact; components: string[]; status: string; startedAt: Date; resolvedAt: Date | null };

function checkDayState(id: StatusComponentId, row: DayRow | undefined, complete: boolean): DayState {
  if (!row || !row.checks) return "none";
  if (row.outage >= OUTAGE_CHECKS_FOR_RED) return "outage";
  if (row.outage > 0 || row.degraded / row.checks >= 0.1) return "degraded";
  if (id === "jobs" && complete && row.checks < CHECKS_PER_DAY * 0.7) return "degraded";
  return "operational";
}

function incidentDayState(id: string, day: string, spans: SpanRow[], now: number): ComponentState {
  const { start, end } = dayBounds(day);
  const hits = spans.filter((s) => {
    if (!s.components.includes(id) || s.status === "scheduled") return false;
    const from = new Date(s.startedAt).getTime();
    const to = s.resolvedAt ? new Date(s.resolvedAt).getTime() : now;
    return from < end && to > start;
  });
  return worst(hits.map((s) => IMPACT_STATE[s.impact]));
}

function liveCheckState(id: StatusComponentId, row: StateRow | undefined, now: number): ComponentState {
  if (!row) return "operational";
  if (id === "jobs") {
    const age = row.lastCheckedAt ? now - new Date(row.lastCheckedAt).getTime() : Infinity;
    if (age > JOBS_DOWN_MS) return "outage";
    if (age > JOBS_STALE_MS) return "degraded";
  }
  return row.state;
}

function overallLabel(state: ComponentState, scheduled: boolean): string {
  if (state === "outage") return "Some systems are down";
  if (state === "degraded") return "Some systems are running slowly";
  if (state === "maintenance") return "Maintenance in progress";
  return scheduled ? "All systems operational, with maintenance scheduled" : "All systems operational";
}

export async function statusSummary(now = new Date()) {
  const nowMs = now.getTime();
  const days = lastDays(BAR_DAYS, now);
  const since = new Date(nowMs - BAR_DAYS * DAY_MS);

  const [states, dayRows, open, recent, spans] = await Promise.all([
    StatusComponentState.find({}).select("component state lastCheckedAt").lean<StateRow[]>(),
    StatusDay.find({ day: { $gte: days[0] } }).select("component day checks degraded outage").lean<DayRow[]>(),
    StatusIncident.find({ resolvedAt: null }).sort({ startedAt: -1 }).limit(20).lean<IncidentRow[]>(),
    StatusIncident.find({ resolvedAt: { $gte: new Date(nowMs - RECENT_DAYS * DAY_MS) } })
      .sort({ startedAt: -1 })
      .limit(30)
      .lean<IncidentRow[]>(),
    StatusIncident.find({ startedAt: { $lt: now }, $or: [{ resolvedAt: null }, { resolvedAt: { $gte: since } }] })
      .select("impact components status startedAt resolvedAt")
      .limit(300)
      .lean<SpanRow[]>(),
  ]);

  const stateById = new Map(states.map((s) => [s.component, s]));
  const dayIndex = new Map(dayRows.map((d) => [`${d.component}|${d.day}`, d]));
  const live = open.filter((i) => i.status !== "scheduled");
  const today = dayKey(now);

  const components = STATUS_COMPONENTS.map(({ id, name, description }) => {
    const incidentState = worst(live.filter((i) => i.components.includes(id)).map((i) => IMPACT_STATE[i.impact]));
    const state = worst([liveCheckState(id, stateById.get(id), nowMs), incidentState]);

    let checks = 0;
    let outage = 0;
    const bars = days.map((day) => {
      const row = dayIndex.get(`${id}|${day}`);
      checks += row?.checks ?? 0;
      outage += row?.outage ?? 0;
      const fromChecks = checkDayState(id, row, day !== today);
      const fromIncidents = incidentDayState(id, day, spans, nowMs);
      const dayState: DayState =
        fromChecks === "none" && fromIncidents === "operational" ? "none" : worst([fromChecks === "none" ? "operational" : fromChecks, fromIncidents]);
      return { day, state: dayState, uptime: row?.checks ? Math.round((1 - row.outage / row.checks) * 10000) / 100 : null };
    });

    return { id, name, description, state, uptime: checks ? Math.round((1 - outage / checks) * 10000) / 100 : null, bars };
  });

  const overall = worst(components.map((c) => c.state));
  return {
    overall,
    overallLabel: overallLabel(overall, open.some((i) => i.status === "scheduled")),
    components,
    active: open.map(presentIncident),
    recent: recent.map(presentIncident),
    updatedAt: now,
  };
}

export async function incidentHistory(before?: Date) {
  const rows = await StatusIncident.find({ startedAt: { $lt: before ?? new Date() } })
    .sort({ startedAt: -1 })
    .limit(HISTORY_PAGE)
    .lean<IncidentRow[]>();
  const last = rows[rows.length - 1];
  return { incidents: rows.map(presentIncident), nextBefore: rows.length === HISTORY_PAGE && last ? last.startedAt : null };
}

export async function publicIncident(id: string) {
  if (!Types.ObjectId.isValid(id)) return null;
  const row = await StatusIncident.findById(id).lean<IncidentRow>();
  return row ? presentIncident(row) : null;
}
