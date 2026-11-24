import axios from "axios";
import { classifyGoogleError, GOOGLE_TIMEOUT_MS } from "./google-oauth.js";

const HISTORY_URL = "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

export const CRUX_HISTORY_WEEKS = 40;

export const CRUX_METRICS = {
  lcp: "largest_contentful_paint",
  inp: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
  fcp: "first_contentful_paint",
  ttfb: "experimental_time_to_first_byte",
} as const;

export type CruxMetricKey = keyof typeof CRUX_METRICS;
export type CruxFormFactor = "PHONE" | "DESKTOP";
export type CruxTarget = { origin: string } | { url: string };

export type CruxSeries = {
  p75s: (number | null)[];
  good: (number | null)[];
  needsImprovement: (number | null)[];
  poor: (number | null)[];
};

export type CruxHistory = {
  periods: string[];
  metrics: Record<CruxMetricKey, CruxSeries | null>;
};

export type CruxFailure = "not_configured" | "busy";

export class CruxError extends Error {
  constructor(readonly failure: CruxFailure, message: string) {
    super(message);
    this.name = "CruxError";
  }
}

type RawDate = { year?: number; month?: number; day?: number };

type RawMetric = {
  histogramTimeseries?: Array<{ densities?: unknown[] }>;
  percentilesTimeseries?: { p75s?: unknown[] };
};

function cruxApiKey(): string {
  return process.env.GOOGLE_PAGESPEED_API_KEY ?? "";
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDate(date: RawDate | undefined): string {
  const pad = (n: number | undefined) => String(n ?? 1).padStart(2, "0");
  return `${date?.year ?? 1970}-${pad(date?.month)}-${pad(date?.day)}`;
}

function seriesOf(raw: RawMetric | undefined): CruxSeries | null {
  const p75s = (raw?.percentilesTimeseries?.p75s ?? []).map(numberOrNull);
  if (!p75s.some((v) => v !== null)) return null;
  const band = (index: number) => (raw?.histogramTimeseries?.[index]?.densities ?? []).map(numberOrNull);
  return { p75s, good: band(0), needsImprovement: band(1), poor: band(2) };
}

function failureOf(err: unknown): CruxError {
  const google = classifyGoogleError(err);
  const busy = google.kind === "quota" || google.kind === "unavailable";
  return new CruxError(busy ? "busy" : "not_configured", google.message);
}

export async function queryCruxHistory(
  target: CruxTarget,
  formFactor: CruxFormFactor | null,
  weeks: number = CRUX_HISTORY_WEEKS,
): Promise<CruxHistory | null> {
  const key = cruxApiKey();
  if (!key) throw new CruxError("not_configured", "no Chrome UX Report API key");

  try {
    const { data } = await axios.post<{
      record?: {
        metrics?: Record<string, RawMetric>;
        collectionPeriods?: Array<{ lastDate?: RawDate }>;
      };
    }>(
      HISTORY_URL,
      {
        ...target,
        ...(formFactor ? { formFactor } : {}),
        metrics: Object.values(CRUX_METRICS),
        collectionPeriodCount: weeks,
      },
      { params: { key }, timeout: GOOGLE_TIMEOUT_MS },
    );

    const raw = data.record?.metrics ?? {};
    const metrics = Object.fromEntries(
      Object.entries(CRUX_METRICS).map(([ours, theirs]) => [ours, seriesOf(raw[theirs])]),
    ) as CruxHistory["metrics"];
    if (!Object.values(metrics).some(Boolean)) return null;

    return { periods: (data.record?.collectionPeriods ?? []).map((p) => isoDate(p.lastDate)), metrics };
  } catch (err) {
    const failure = failureOf(err);
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 404 || (status === 400 && !/api key/i.test(failure.message))) return null;
    throw failure;
  }
}
