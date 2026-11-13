import { Types } from "mongoose";
import { badRequest, notFound } from "../../shared/errors/index.js";
import { StatusIncident } from "./models/StatusIncident.js";
import { StatusEmailJob } from "./models/StatusEmailJob.js";
import { StatusComponentState } from "./models/StatusComponentState.js";
import {
  CLOSED_STATUSES,
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  STATUS_COMPONENTS,
  isStatusComponent,
  type IncidentImpact,
  type IncidentStatus,
  type StatusComponentId,
} from "./components.js";
import { presentIncident, type IncidentRow } from "./present.js";
import { subscriberCounts } from "./subscribers.service.js";

const MAX_TITLE = 160;
const MAX_BODY = 5000;
const ADMIN_LIST = 40;

type Input = Record<string, unknown>;

const asInput = (body: unknown): Input => (body && typeof body === "object" ? (body as Input) : {});

function text(value: unknown, min: number, max: number, label: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min || s.length > max) throw badRequest(`${label} must be ${min} to ${max} characters`);
  return s;
}

function impactOf(value: unknown): IncidentImpact {
  if (!INCIDENT_IMPACTS.includes(value as IncidentImpact)) throw badRequest("Pick an impact");
  return value as IncidentImpact;
}

function statusOf(value: unknown): IncidentStatus {
  if (!INCIDENT_STATUSES.includes(value as IncidentStatus)) throw badRequest("Pick a status");
  return value as IncidentStatus;
}

function componentsOf(value: unknown): StatusComponentId[] {
  const list = Array.isArray(value) ? [...new Set(value.filter(isStatusComponent))] : [];
  if (!list.length) throw badRequest("Pick at least one affected part of Quantalog");
  return list;
}

async function queueEmail(incidentId: Types.ObjectId, updateId: Types.ObjectId, notify: unknown): Promise<void> {
  if (notify === false) return;
  await StatusEmailJob.create({ incidentId, updateId });
}

async function rowOrThrow(id: string): Promise<IncidentRow> {
  if (!Types.ObjectId.isValid(id)) throw notFound("Incident not found");
  const row = await StatusIncident.findById(id).lean<IncidentRow>();
  if (!row) throw notFound("Incident not found");
  return row;
}

export async function createIncident(body: unknown, authorId: string) {
  const input = asInput(body);
  const status = statusOf(input.status ?? "investigating");
  const now = new Date();
  const updateId = new Types.ObjectId();
  const startedAt = input.startedAt ? new Date(String(input.startedAt)) : now;
  if (Number.isNaN(startedAt.getTime())) throw badRequest("Start time is not a valid date");

  const doc = await StatusIncident.create({
    title: text(input.title, 3, MAX_TITLE, "Title"),
    impact: impactOf(input.impact),
    components: componentsOf(input.components),
    status,
    startedAt,
    resolvedAt: CLOSED_STATUSES.includes(status) ? now : null,
    updates: [{ _id: updateId, status, body: text(input.body, 3, MAX_BODY, "Message"), at: now, authorId }],
  });
  await queueEmail(doc._id, updateId, input.notify);
  return presentIncident(doc.toObject() as unknown as IncidentRow);
}

export async function postUpdate(id: string, body: unknown, authorId: string) {
  const input = asInput(body);
  const row = await rowOrThrow(id);
  const status = statusOf(input.status);
  const message = text(input.body, 3, MAX_BODY, "Message");
  const now = new Date();
  const updateId = new Types.ObjectId();

  await StatusIncident.updateOne(
    { _id: row._id },
    {
      $set: { status, resolvedAt: CLOSED_STATUSES.includes(status) ? row.resolvedAt ?? now : null },
      $push: { updates: { _id: updateId, status, body: message, at: now, authorId } },
    },
  );
  await queueEmail(row._id, updateId, input.notify);
  return presentIncident(await rowOrThrow(id));
}

export async function editIncident(id: string, body: unknown) {
  const input = asInput(body);
  const row = await rowOrThrow(id);
  const set: Record<string, unknown> = {};
  if (input.title !== undefined) set.title = text(input.title, 3, MAX_TITLE, "Title");
  if (input.impact !== undefined) set.impact = impactOf(input.impact);
  if (input.components !== undefined) set.components = componentsOf(input.components);
  if (Object.keys(set).length) await StatusIncident.updateOne({ _id: row._id }, { $set: set });
  return presentIncident(await rowOrThrow(id));
}

export async function deleteIncident(id: string): Promise<void> {
  const row = await rowOrThrow(id);
  await Promise.all([StatusIncident.deleteOne({ _id: row._id }), StatusEmailJob.deleteMany({ incidentId: row._id })]);
}

type LiveRow = { component: string; state: string; latencyMs: number | null; message: string; lastCheckedAt: Date | null; lastOkAt: Date | null };

export async function adminStatusOverview() {
  const [states, open, closed, subscribers, pendingEmails] = await Promise.all([
    StatusComponentState.find({}).lean<LiveRow[]>(),
    StatusIncident.find({ resolvedAt: null }).sort({ startedAt: -1 }).limit(ADMIN_LIST).lean<IncidentRow[]>(),
    StatusIncident.find({ resolvedAt: { $ne: null } }).sort({ startedAt: -1 }).limit(ADMIN_LIST).lean<IncidentRow[]>(),
    subscriberCounts(),
    StatusEmailJob.countDocuments({ done: false }),
  ]);
  const byId = new Map(states.map((s) => [s.component, s]));
  return {
    components: STATUS_COMPONENTS.map(({ id, name }) => {
      const s = byId.get(id);
      return {
        id,
        name,
        state: s?.state ?? "unknown",
        latencyMs: s?.latencyMs ?? null,
        message: s?.message ?? "Not checked yet",
        lastCheckedAt: s?.lastCheckedAt ?? null,
        lastOkAt: s?.lastOkAt ?? null,
      };
    }),
    open: open.map(presentIncident),
    closed: closed.map(presentIncident),
    subscribers,
    pendingEmails,
  };
}
