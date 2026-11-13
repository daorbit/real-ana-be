import { Types } from "mongoose";
import { Workspace } from "../workspace/models/Workspace.js";
import { emit } from "../notifications/notify.service.js";
import { cronDeadline } from "../../shared/utils/time-budget.js";
import { RadarScan } from "./models/RadarScan.js";
import { DETECTORS } from "./detectors/index.js";
import { loadSources, sourceReady, type RadarData } from "./sources/index.js";
import { radarConfig, type RadarConfig } from "./settings.service.js";
import { groupSignals } from "./aggregate.js";
import { applySignals, saveExplanations, type Applied } from "./apply-signals.js";
import { explainSignals } from "./explain.js";
import { prioritise } from "./priority.js";
import { nextScanAfter } from "./windows.js";
import { DETECTOR_IDS, type DetectorRun, type Reading, type RadarSourceId, type Signal } from "./types.js";

const SCAN_HOUR_UTC = 6;
const MAX_EXPLAINED = 3;
const CRON_BATCH = 6;
const CRON_CONCURRENCY = 2;
const CRON_BUDGET_MS = 60_000;

export type ScanTrigger = "schedule" | "manual" | "first";

const SOURCE_NAMES: Record<RadarSourceId, string> = {
  analytics: "Website analytics",
  leadCapture: "Lead capture",
  bookings: "booking forms",
  searchConsole: "Google Search Console",
};

function runDetectors(data: RadarData, config: RadarConfig) {
  const runs: DetectorRun[] = [];
  const signals: Signal[] = [];
  const readings: Reading[] = [];

  for (const id of DETECTOR_IDS) {
    const spec = DETECTORS[id];
    const setting = config.detectors[id];
    const base = { id, version: spec.version };
    if (!setting.enabled) {
      runs.push({ ...base, status: "off", reason: "Turned off in settings.", found: 0 });
      continue;
    }
    const missing = spec.requires.filter((source) => !sourceReady(data, source));
    if (missing.length) {
      runs.push({ ...base, status: "skipped", reason: `Needs ${missing.map((s) => SOURCE_NAMES[s]).join(" and ")}.`, found: 0 });
      continue;
    }
    try {
      const result = spec.run(data, setting.threshold);
      if ("skipped" in result) {
        runs.push({ ...base, status: "skipped", reason: result.skipped, found: 0 });
        continue;
      }
      signals.push(...result.signals);
      readings.push(...result.readings);
      runs.push({ ...base, status: "ran", reason: "", found: result.signals.length });
    } catch (e) {
      console.error(`[growth-radar] detector ${id} failed:`, (e as Error)?.message);
      runs.push({ ...base, status: "failed", reason: "This check failed and will run again on the next scan.", found: 0 });
    }
  }

  return { runs, signals: groupSignals(signals), readings };
}

async function notifyHighPriority(workspaceId: string, applied: Applied[]): Promise<void> {
  const high = applied.filter((a) => a.notifiable && prioritise(a.signal.factors).priority === "high");
  if (!high.length) return;
  await emit({
    type: "radar.opportunity",
    workspaceId,
    data: { count: high.length, title: high[0].signal.title },
    link: high.length === 1 ? `/app/growth-radar/${high[0].id}` : "/app/growth-radar",
  });
}

async function explainFresh(applied: Applied[]): Promise<void> {
  const chosen = [...applied]
    .sort((a, b) => Number(a.kind === "updated") - Number(b.kind === "updated"))
    .slice(0, MAX_EXPLAINED);
  if (!chosen.length) return;
  const explanations = await explainSignals(chosen.map((a) => a.signal));
  await saveExplanations(explanations, chosen);
}

async function scheduleNext(workspaceId: string, now: Date): Promise<void> {
  await Workspace.updateOne(
    { _id: workspaceId, "apps.growthRadar.enabled": true },
    { $set: { "apps.growthRadar.nextScanAt": nextScanAfter(now, SCAN_HOUR_UTC) } },
  );
}

export async function runScan(workspaceId: string, trigger: ScanTrigger) {
  const startedAt = new Date();
  const scanId = new Types.ObjectId();
  const [workspace, config] = await Promise.all([
    Workspace.findById(workspaceId).select("userId").lean<{ userId: unknown }>(),
    radarConfig(workspaceId),
  ]);
  if (!workspace) throw new Error("workspace not found");

  try {
    const data = await loadSources(workspaceId, String(workspace.userId), startedAt);
    const { runs, signals, readings } = runDetectors(data, config);
    const ranDetectors = runs.filter((r) => r.status === "ran").map((r) => r.id);
    const applied = await applySignals(workspaceId, scanId, signals, ranDetectors, readings, startedAt);

    await Promise.all([
      config.aiExplanations
        ? explainFresh(applied).catch((e) => console.error("[growth-radar] explanations failed:", (e as Error)?.message))
        : Promise.resolve(),
      config.notifyHighPriority ? notifyHighPriority(workspaceId, applied) : Promise.resolve(),
    ]);

    const degraded = runs.some((r) => r.status === "failed") || data.statuses.some((s) => s.state === "error");
    const scan = await RadarScan.create({
      _id: scanId,
      workspaceId,
      trigger,
      status: degraded ? "partial" : "ok",
      startedAt,
      finishedAt: new Date(),
      sources: data.statuses,
      detectors: runs,
      found: signals.length,
      created: applied.filter((a) => a.kind === "created").length,
      reopened: applied.filter((a) => a.kind === "reopened").length,
    });
    await scheduleNext(workspaceId, startedAt);
    return scan.toObject();
  } catch (e) {
    const message = (e as Error)?.message ?? "scan failed";
    console.error(`[growth-radar] scan for ${workspaceId} failed:`, message);
    const scan = await RadarScan.create({
      _id: scanId,
      workspaceId,
      trigger,
      status: "failed",
      error: "The scan could not finish. It will run again at the next scheduled time.",
      startedAt,
      finishedAt: new Date(),
    });
    await scheduleNext(workspaceId, startedAt);
    return scan.toObject();
  }
}

export function plannedScanAt(stored: Date | null | undefined, now = new Date()): Date {
  return stored && new Date(stored).getTime() > now.getTime() ? new Date(stored) : nextScanAfter(now, SCAN_HOUR_UTC);
}

export async function scheduleGrowthRadar(workspaceId: string, enabled: boolean): Promise<void> {
  await Workspace.updateOne({ _id: workspaceId }, { $set: { "apps.growthRadar.nextScanAt": enabled ? new Date() : null } });
}

async function claim(workspaceId: unknown, now: Date): Promise<boolean> {
  const result = await Workspace.updateOne(
    { _id: workspaceId, "apps.growthRadar.nextScanAt": { $lte: now } },
    { $set: { "apps.growthRadar.nextScanAt": nextScanAfter(now, SCAN_HOUR_UTC) } },
  );
  return result.modifiedCount === 1;
}

export async function runDueRadarScans(now = new Date()): Promise<{ scanned: number; failed: number; errors: string[] }> {
  const outOfTime = cronDeadline(CRON_BUDGET_MS);
  const due = await Workspace.find({
    "apps.growthRadar.enabled": true,
    "apps.growthRadar.nextScanAt": { $ne: null, $lte: now },
  })
    .sort({ "apps.growthRadar.nextScanAt": 1 })
    .limit(CRON_BATCH)
    .select("_id")
    .lean();

  let scanned = 0;
  let failed = 0;
  const errors: string[] = [];
  for (let i = 0; i < due.length && !outOfTime(); i += CRON_CONCURRENCY) {
    const slice = due.slice(i, i + CRON_CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map(async (w) => ((await claim(w._id, now)) ? runScan(String(w._id), "schedule") : null)),
    );
    results.forEach((r, j) => {
      if (r.status === "rejected") {
        failed += 1;
        errors.push(`${slice[j]._id}: ${(r.reason as Error)?.message ?? "failed"}`);
      } else if (r.value) {
        if (r.value.status === "failed") failed += 1;
        else scanned += 1;
      }
    });
  }
  return { scanned, failed, errors };
}
