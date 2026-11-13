import { Types } from "mongoose";
import { ACTIVE_STATUSES, RadarOpportunity, type OpportunityStatus } from "./models/RadarOpportunity.js";
import { DETECTORS } from "./detectors/index.js";
import { prioritise } from "./priority.js";
import { DAY_MS } from "./windows.js";
import type { DetectorId, Reading, Signal } from "./types.js";

type WriteOps = Parameters<typeof RadarOpportunity.bulkWrite>[0];

const ARCHIVE_AFTER_MS = 14 * DAY_MS;
const ACTIVITY_KEPT = 100;
const MAX_ROWS = 500;

type Existing = {
  _id: Types.ObjectId;
  fingerprint: string;
  detector: string;
  status: OpportunityStatus;
  detected: boolean;
  lastDetectedAt: Date;
  snoozedUntil: Date | null;
  action: { metric: string; startedAt: Date } | null;
};

export type Applied = { id: string; signal: Signal; kind: "created" | "reopened" | "updated"; notifiable: boolean };

function evidenceOf(signal: Signal, scanId: Types.ObjectId, now: Date) {
  const { priority, rank, reason } = prioritise(signal.factors);
  return {
    detector: signal.detector,
    detectorVersion: DETECTORS[signal.detector].version,
    category: signal.category,
    priority,
    priorityRank: rank,
    priorityReason: reason,
    factors: signal.factors,
    entity: signal.entity,
    title: signal.title,
    summary: signal.summary,
    aiSummary: "",
    whyItMatters: signal.whyItMatters,
    nextSteps: signal.nextSteps,
    limitations: signal.limitations,
    metrics: signal.metrics,
    primaryMetric: signal.primaryMetric,
    period: signal.period,
    sampleSize: signal.sampleSize,
    sources: signal.sources,
    detected: true,
    lastDetectedAt: now,
    lastScanId: scanId,
  };
}

function activity(kind: string, detail: string, now: Date) {
  return { $each: [{ at: now, userId: null, kind, detail }], $slice: -ACTIVITY_KEPT };
}

function isSnoozed(row: Existing, now: Date): boolean {
  return Boolean(row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime());
}

export async function applySignals(
  workspaceId: string,
  scanId: Types.ObjectId,
  signals: Signal[],
  ranDetectors: DetectorId[],
  readings: Reading[],
  now: Date,
): Promise<Applied[]> {
  const fingerprints = [...new Set([...signals.map((s) => s.fingerprint), ...readings.map((r) => r.fingerprint)])];
  const existing = await RadarOpportunity.find({
    workspaceId,
    $or: [{ fingerprint: { $in: fingerprints } }, { detector: { $in: ranDetectors }, status: { $in: ACTIVE_STATUSES } }],
  })
    .select("fingerprint detector status detected lastDetectedAt snoozedUntil action.metric action.startedAt")
    .limit(MAX_ROWS)
    .lean<Existing[]>();

  const byFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  const seen = new Set(signals.map((s) => s.fingerprint));
  const ops: WriteOps = [];
  const inserts: Record<string, unknown>[] = [];
  const applied: Applied[] = [];

  for (const signal of signals) {
    const row = byFingerprint.get(signal.fingerprint);
    const evidence = evidenceOf(signal, scanId, now);

    if (!row) {
      const _id = new Types.ObjectId();
      inserts.push({
        _id,
        workspaceId,
        fingerprint: signal.fingerprint,
        status: "open",
        firstDetectedAt: now,
        ...evidence,
        activity: [{ at: now, userId: null, kind: "detected", detail: "" }],
      });
      applied.push({ id: String(_id), signal, kind: "created", notifiable: true });
      continue;
    }

    const reopen = row.status === "resolved" || row.status === "archived";
    ops.push({
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: { ...evidence, ...(reopen ? { status: "open", closedAt: null, snoozedUntil: null } : {}) },
          ...(reopen ? { $push: { activity: activity("reopened", "Detected again", now) } } : {}),
        },
      },
    });
    applied.push({
      id: String(row._id),
      signal,
      kind: reopen ? "reopened" : "updated",
      notifiable: reopen && !isSnoozed(row, now),
    });
  }

  const ran = new Set<string>(ranDetectors);
  for (const row of existing) {
    if (seen.has(row.fingerprint) || !ran.has(row.detector) || !ACTIVE_STATUSES.includes(row.status)) continue;
    const stale = now.getTime() - new Date(row.lastDetectedAt).getTime() >= ARCHIVE_AFTER_MS;
    if (stale) {
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { status: "archived", detected: false, closedAt: now }, $push: { activity: activity("archived", "Not detected for 14 days", now) } },
        },
      });
    } else if (row.detected) {
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { detected: false }, $push: { activity: activity("cleared", "No longer detected", now) } },
        },
      });
    }
  }

  for (const reading of readings) {
    const row = byFingerprint.get(reading.fingerprint);
    if (!row?.action || row.action.metric !== reading.metric) continue;
    if (reading.periodStart.getTime() < new Date(row.action.startedAt).getTime()) continue;
    ops.push({
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            "action.latest": { value: reading.value, periodStart: reading.periodStart, periodEnd: reading.periodEnd },
          },
        },
      },
    });
  }

  await Promise.all([
    inserts.length ? RadarOpportunity.insertMany(inserts, { ordered: false }) : null,
    ops.length ? RadarOpportunity.bulkWrite(ops, { ordered: false }) : null,
  ]);
  return applied;
}

export async function saveExplanations(explanations: Map<string, string>, applied: Applied[]): Promise<void> {
  const ops: WriteOps = applied
    .filter((a) => explanations.get(a.signal.fingerprint))
    .map((a) => ({
      updateOne: { filter: { _id: new Types.ObjectId(a.id) }, update: { $set: { aiSummary: explanations.get(a.signal.fingerprint) } } },
    }));
  if (ops.length) await RadarOpportunity.bulkWrite(ops, { ordered: false });
}
