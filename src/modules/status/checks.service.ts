import { overRateLimit } from "../security/rate-limit.service.js";
import { sendOpsAlert } from "../../infra/monitoring/ops-alert.js";
import { StatusComponentState } from "./models/StatusComponentState.js";
import { StatusDay } from "./models/StatusDay.js";
import { PROBES, type ProbeResult } from "./probes.js";
import { STATUS_COMPONENTS, type StatusComponentId } from "./components.js";
import { dayKey } from "./days.js";

const CHECK_EVERY_MS = 4 * 60 * 1000;
const OUTAGE_AFTER_FAILURES = 2;
const KEEP_DAYS_MS = 120 * 24 * 60 * 60 * 1000;

type CheckState = "operational" | "degraded" | "outage";
type Previous = { component: string; state: CheckState; failures: number };

function nameOf(id: StatusComponentId): string {
  return STATUS_COMPONENTS.find((c) => c.id === id)?.name ?? id;
}

function nextState(result: ProbeResult, failures: number): CheckState {
  if (result.ok) return result.slow ? "degraded" : "operational";
  return failures >= OUTAGE_AFTER_FAILURES ? "outage" : "degraded";
}

async function alertTransition(id: StatusComponentId, from: CheckState, to: CheckState, message: string): Promise<void> {
  if (to === "outage" && from !== "outage") {
    await sendOpsAlert({ title: `${nameOf(id)} is down`, where: `status · ${id}`, detail: message });
  } else if (from === "outage" && to === "operational") {
    await sendOpsAlert({ title: `${nameOf(id)} is back`, where: `status · ${id}`, detail: "The health check passed again." });
  }
}

export async function runStatusChecks(now = new Date()): Promise<{ checked: number; skipped: boolean }> {
  if (await overRateLimit("status-checks", 1, CHECK_EVERY_MS)) return { checked: 0, skipped: true };

  const [results, previous] = await Promise.all([
    Promise.all(PROBES.map(async (probe) => ({ id: probe.id, result: await probe.run().catch(() => null) }))),
    StatusComponentState.find({}).select("component state failures").lean<Previous[]>(),
  ]);
  const before = new Map(previous.map((p) => [p.component, p]));
  const day = dayKey(now);
  const expiresAt = new Date(now.getTime() + KEEP_DAYS_MS);

  const stateOps: Parameters<typeof StatusComponentState.bulkWrite>[0] = [];
  const dayOps: Parameters<typeof StatusDay.bulkWrite>[0] = [];
  const transitions: Promise<void>[] = [];

  for (const { id, result } of results) {
    if (!result) continue;
    const prior = before.get(id);
    const failures = result.ok ? 0 : (prior?.failures ?? 0) + 1;
    const state = nextState(result, failures);

    stateOps.push({
      updateOne: {
        filter: { component: id },
        update: {
          $set: {
            state,
            failures,
            latencyMs: result.latencyMs,
            message: result.message,
            lastCheckedAt: now,
            ...(result.ok ? { lastOkAt: now } : {}),
          },
        },
        upsert: true,
      },
    });
    dayOps.push({
      updateOne: {
        filter: { component: id, day },
        update: {
          $inc: { checks: 1, degraded: state === "degraded" ? 1 : 0, outage: state === "outage" ? 1 : 0 },
          $setOnInsert: { expiresAt },
        },
        upsert: true,
      },
    });
    if (prior && prior.state !== state) transitions.push(alertTransition(id, prior.state, state, result.message));
  }

  await Promise.all([
    stateOps.length ? StatusComponentState.bulkWrite(stateOps, { ordered: false }) : null,
    dayOps.length ? StatusDay.bulkWrite(dayOps, { ordered: false }) : null,
    ...transitions,
  ]);
  return { checked: stateOps.length, skipped: false };
}
