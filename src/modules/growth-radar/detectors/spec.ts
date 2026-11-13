import type { RadarData } from "../sources/index.js";
import type { DetectorId, DetectorResult, RadarCategory, RadarSourceId } from "../types.js";

export type DetectorThreshold = {
  default: number;
  min: number;
  max: number;
  step: number;
};

export type DetectorSpec = {
  id: DetectorId;
  version: number;
  category: RadarCategory;
  requires: RadarSourceId[];
  threshold: DetectorThreshold;
  run: (data: RadarData, threshold: number) => DetectorResult | { skipped: string };
};

export const EMPTY_RESULT: DetectorResult = { signals: [], readings: [] };
