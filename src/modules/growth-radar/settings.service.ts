import { RadarSettings } from "./models/RadarSettings.js";
import { DETECTORS } from "./detectors/index.js";
import { DETECTOR_IDS, type DetectorId } from "./types.js";

export type DetectorSetting = { enabled: boolean; threshold: number };

export type RadarConfig = {
  detectors: Record<DetectorId, DetectorSetting>;
  notifyHighPriority: boolean;
  aiExplanations: boolean;
};

type StoredSettings = {
  detectors?: Record<string, Partial<DetectorSetting> | undefined>;
  notifyHighPriority?: boolean;
  aiExplanations?: boolean;
} | null;

function clampThreshold(id: DetectorId, value: unknown): number {
  const { threshold } = DETECTORS[id];
  const n = typeof value === "number" && Number.isFinite(value) ? value : threshold.default;
  const stepped = Math.round(n / threshold.step) * threshold.step;
  return Math.min(threshold.max, Math.max(threshold.min, stepped));
}

export function configOf(stored: StoredSettings): RadarConfig {
  const detectors = Object.fromEntries(
    DETECTOR_IDS.map((id) => {
      const saved = stored?.detectors?.[id];
      return [id, { enabled: saved?.enabled !== false, threshold: clampThreshold(id, saved?.threshold) }];
    }),
  ) as Record<DetectorId, DetectorSetting>;
  return {
    detectors,
    notifyHighPriority: stored?.notifyHighPriority !== false,
    aiExplanations: stored?.aiExplanations !== false,
  };
}

export async function radarConfig(workspaceId: string): Promise<RadarConfig> {
  const stored = await RadarSettings.findOne({ workspaceId }).select("detectors notifyHighPriority aiExplanations").lean<StoredSettings>();
  return configOf(stored);
}

export async function saveRadarConfig(workspaceId: string, body: unknown): Promise<RadarConfig | string> {
  if (!body || typeof body !== "object") return "settings are required";
  const input = body as Record<string, unknown>;
  const rawDetectors = input.detectors && typeof input.detectors === "object" ? (input.detectors as Record<string, unknown>) : {};

  const current = await radarConfig(workspaceId);
  const detectors = { ...current.detectors };
  for (const id of DETECTOR_IDS) {
    const raw = rawDetectors[id];
    if (!raw || typeof raw !== "object") continue;
    const patch = raw as Record<string, unknown>;
    detectors[id] = {
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : detectors[id].enabled,
      threshold: patch.threshold === undefined ? detectors[id].threshold : clampThreshold(id, patch.threshold),
    };
  }

  const next: RadarConfig = {
    detectors,
    notifyHighPriority: typeof input.notifyHighPriority === "boolean" ? input.notifyHighPriority : current.notifyHighPriority,
    aiExplanations: typeof input.aiExplanations === "boolean" ? input.aiExplanations : current.aiExplanations,
  };

  await RadarSettings.updateOne({ workspaceId }, { $set: next }, { upsert: true });
  return next;
}

export function detectorCatalog() {
  return DETECTOR_IDS.map((id) => {
    const spec = DETECTORS[id];
    return { id, version: spec.version, category: spec.category, requires: spec.requires, threshold: spec.threshold };
  });
}
