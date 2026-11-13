import type { Types } from "mongoose";

export const CARD_FIELDS =
  "detector category status priority priorityRank priorityReason factors entity title summary aiSummary metrics primaryMetric period sources detected firstDetectedAt lastDetectedAt snoozedUntil assigneeId action.startedAt closedAt";

type Metric = { key: string; label: string; current: number; previous: number | null; unit: "count" | "percent" };

export type OpportunityRow = {
  _id: Types.ObjectId;
  detector: string;
  detectorVersion?: number;
  category: string;
  status: string;
  priority: string;
  priorityReason?: string;
  factors: Record<string, { level: string; reason: string }>;
  entity: { type: string; key: string; label: string };
  title: string;
  summary?: string;
  aiSummary?: string;
  whyItMatters?: string;
  nextSteps?: string[];
  limitations?: string[];
  metrics?: Metric[];
  primaryMetric: string;
  period: { start: Date; end: Date; previousStart: Date | null; previousEnd: Date | null; days: number; includesToday: boolean };
  sampleSize?: number;
  sources?: string[];
  detected?: boolean;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  snoozedUntil?: Date | null;
  assigneeId?: Types.ObjectId | null;
  dismissReason?: string;
  closedAt?: Date | null;
  notes?: { _id: Types.ObjectId; userId: Types.ObjectId; text: string; at: Date }[];
  activity?: { at: Date; userId: Types.ObjectId | null; kind: string; detail: string }[];
  action?: {
    description: string;
    otherChanges?: string;
    userId: Types.ObjectId;
    startedAt: Date;
    followUpDays: number;
    followUpEndsAt: Date;
    metric: string;
    baseline: number;
    latest?: { value?: number; periodStart?: Date; periodEnd?: Date };
  } | null;
};

export type Person = { id: string; name: string; avatarUrl: string };

export type ScanRow = {
  _id: Types.ObjectId;
  trigger: string;
  status: string;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
  sources?: unknown[];
  detectors?: unknown[];
  found?: number;
  created?: number;
  reopened?: number;
};

export function presentCard(row: OpportunityRow) {
  return {
    id: String(row._id),
    detector: row.detector,
    category: row.category,
    status: row.status,
    priority: row.priority,
    priorityReason: row.priorityReason ?? "",
    factors: row.factors,
    entity: row.entity,
    title: row.title,
    summary: row.aiSummary || row.summary || "",
    explainedBy: row.aiSummary ? "orbit" : "rules",
    metrics: row.metrics ?? [],
    primaryMetric: row.primaryMetric,
    period: row.period,
    sources: row.sources ?? [],
    detected: row.detected !== false,
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    snoozedUntil: row.snoozedUntil ?? null,
    assigneeId: row.assigneeId ? String(row.assigneeId) : null,
    hasAction: Boolean(row.action?.startedAt),
    closedAt: row.closedAt ?? null,
  };
}

function presentAction(action: NonNullable<OpportunityRow["action"]>, metrics: Metric[], people: Map<string, Person>) {
  const metric = metrics.find((m) => m.key === action.metric);
  const latest = typeof action.latest?.value === "number" ? action.latest : null;
  return {
    description: action.description,
    otherChanges: action.otherChanges ?? "",
    by: people.get(String(action.userId)) ?? null,
    startedAt: action.startedAt,
    followUpDays: action.followUpDays,
    followUpEndsAt: action.followUpEndsAt,
    metric: action.metric,
    metricLabel: metric?.label ?? action.metric,
    unit: metric?.unit ?? "count",
    baseline: action.baseline,
    latest: latest ? { value: latest.value as number, periodStart: latest.periodStart, periodEnd: latest.periodEnd } : null,
  };
}

export function presentDetail(row: OpportunityRow, people: Map<string, Person>) {
  const metrics = row.metrics ?? [];
  return {
    ...presentCard(row),
    templateSummary: row.summary ?? "",
    detectorVersion: row.detectorVersion ?? 1,
    whyItMatters: row.whyItMatters ?? "",
    nextSteps: row.nextSteps ?? [],
    limitations: row.limitations ?? [],
    sampleSize: row.sampleSize ?? 0,
    dismissReason: row.dismissReason ?? "",
    assignee: row.assigneeId ? people.get(String(row.assigneeId)) ?? null : null,
    notes: (row.notes ?? [])
      .map((n) => ({ id: String(n._id), text: n.text, at: n.at, author: people.get(String(n.userId)) ?? null }))
      .reverse(),
    activity: (row.activity ?? [])
      .map((a) => ({ at: a.at, kind: a.kind, detail: a.detail, actor: a.userId ? people.get(String(a.userId)) ?? null : null }))
      .reverse(),
    action: row.action?.startedAt ? presentAction(row.action, metrics, people) : null,
  };
}

export function presentScan(row: ScanRow) {
  return {
    id: String(row._id),
    trigger: row.trigger,
    status: row.status,
    error: row.error ?? "",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    sources: row.sources ?? [],
    detectors: row.detectors ?? [],
    found: row.found ?? 0,
    created: row.created ?? 0,
    reopened: row.reopened ?? 0,
  };
}
