import type { Types } from "mongoose";
import { STATUS_LABEL, type IncidentImpact, type IncidentStatus } from "./components.js";

export type IncidentRow = {
  _id: Types.ObjectId;
  title: string;
  impact: IncidentImpact;
  components: string[];
  status: IncidentStatus;
  updates: { _id: Types.ObjectId; status: IncidentStatus; body: string; at: Date }[];
  startedAt: Date;
  resolvedAt: Date | null;
};

export function presentIncident(row: IncidentRow) {
  return {
    id: String(row._id),
    title: row.title,
    impact: row.impact,
    components: row.components,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status],
    startedAt: row.startedAt,
    resolvedAt: row.resolvedAt,
    updates: [...(row.updates ?? [])]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .map((u) => ({ id: String(u._id), status: u.status, statusLabel: STATUS_LABEL[u.status], body: u.body, at: u.at })),
  };
}

export type PresentedIncident = ReturnType<typeof presentIncident>;
