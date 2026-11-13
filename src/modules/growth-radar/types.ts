export const RADAR_SOURCES = ["analytics", "leadCapture", "bookings", "searchConsole"] as const;
export type RadarSourceId = (typeof RADAR_SOURCES)[number];

export type SourceState = "ready" | "not_connected" | "stale" | "error";

export type SourceStatus = {
  id: RadarSourceId;
  state: SourceState;
  detail: string;
  freshAt: Date | null;
};

export const DETECTOR_IDS = [
  "trafficWithoutLeads",
  "pageConversionGap",
  "formRateDecline",
  "searchCtrGap",
  "bookingDecline",
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

export type RadarCategory =
  | "traffic_without_enquiries"
  | "conversion_gap"
  | "form_performance"
  | "search_visibility"
  | "booking_journey";

export type Level = "high" | "medium" | "low";

export type Factor = { level: Level; reason: string };

export type Factors = { impact: Factor; confidence: Factor; urgency: Factor; effort: Factor };

export type MetricUnit = "count" | "percent";

export type EvidenceMetric = {
  key: string;
  label: string;
  current: number;
  previous: number | null;
  unit: MetricUnit;
};

export type RadarPeriod = {
  start: Date;
  end: Date;
  previousStart: Date | null;
  previousEnd: Date | null;
  days: number;
  includesToday: boolean;
};

export type EntityType = "workspace" | "page" | "form" | "bookingForm" | "searchProperty";

export type RadarEntity = { type: EntityType; key: string; label: string };

export type Signal = {
  detector: DetectorId;
  fingerprint: string;
  category: RadarCategory;
  entity: RadarEntity;
  title: string;
  summary: string;
  whyItMatters: string;
  nextSteps: string[];
  limitations: string[];
  metrics: EvidenceMetric[];
  primaryMetric: string;
  period: RadarPeriod;
  sampleSize: number;
  sources: RadarSourceId[];
  factors: Factors;
};

export type Reading = {
  fingerprint: string;
  metric: string;
  value: number;
  periodStart: Date;
  periodEnd: Date;
};

export type DetectorResult = { signals: Signal[]; readings: Reading[] };

export type DetectorRun = {
  id: DetectorId;
  version: number;
  status: "ran" | "skipped" | "failed" | "off";
  reason: string;
  found: number;
};
