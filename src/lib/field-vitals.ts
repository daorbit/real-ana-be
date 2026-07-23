import { Event } from "../models/Event.js";

/**
 * Core Web Vitals as real visitors experienced them.
 *
 * Lighthouse simulates one load on synthetic hardware; this is the
 * distribution of what actually happened on real devices and networks. Google
 * ranks on the field data, so where the two disagree, this is the one that
 * counts.
 *
 * **Reported at the 75th percentile**, which is how Google evaluates a page: a
 * mean is flattered by fast visitors and hides the slow tail that costs
 * rankings. p75 answers "what do my slower visitors get", which is the
 * question worth asking.
 */

export type VitalKey = "lcp" | "cls" | "inp" | "fcp" | "ttfb";

export type VitalSummary = {
  /** 75th percentile — the figure Google judges. */
  p75: number | null;
  /** Median, for a sense of the spread against p75. */
  p50: number | null;
  /** Samples behind the figures. */
  samples: number;
  /** Share of samples in each Google band, as percentages. */
  good: number;
  needsImprovement: number;
  poor: number;
  rating: "good" | "needs-improvement" | "poor" | "none";
};

export type FieldVitals = {
  /** Engagement records carrying at least one metric. */
  samples: number;
  days: number;
  metrics: Record<VitalKey, VitalSummary>;
  /** Slowest pages by LCP p75, where there is enough data to be meaningful. */
  byPage: { path: string; lcp: number | null; cls: number | null; samples: number }[];
};

/** Google's thresholds. Below `good` passes; above `poor` fails. */
export const THRESHOLDS: Record<VitalKey, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
};

const KEYS: VitalKey[] = ["lcp", "cls", "inp", "fcp", "ttfb"];

/** Nearest-rank percentile over a pre-sorted array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarise(values: number[], key: VitalKey): VitalSummary {
  const empty: VitalSummary = {
    p75: null,
    p50: null,
    samples: 0,
    good: 0,
    needsImprovement: 0,
    poor: 0,
    rating: "none",
  };
  if (!values.length) return empty;

  const sorted = [...values].sort((a, b) => a - b);
  const { good, poor } = THRESHOLDS[key];

  let g = 0;
  let n = 0;
  let p = 0;
  for (const v of sorted) {
    if (v <= good) g++;
    else if (v <= poor) n++;
    else p++;
  }

  const total = sorted.length;
  const p75 = percentile(sorted, 75);
  const round = (v: number | null) =>
    v === null ? null : key === "cls" ? Math.round(v * 1000) / 1000 : Math.round(v);

  return {
    p75: round(p75),
    p50: round(percentile(sorted, 50)),
    samples: total,
    good: Math.round((g / total) * 100),
    needsImprovement: Math.round((n / total) * 100),
    poor: Math.round((p / total) * 100),
    // The rating follows p75 against the same thresholds, so it agrees with
    // the headline number rather than with the distribution.
    rating: p75 === null ? "none" : p75 <= good ? "good" : p75 <= poor ? "needs-improvement" : "poor",
  };
}

/** Pages need a handful of samples before a percentile means anything. */
const MIN_PAGE_SAMPLES = 5;

export async function computeFieldVitals(
  siteIds: string[],
  since: Date
): Promise<FieldVitals> {
  const rows = await Event.find({
    siteId: { $in: siteIds },
    type: "engagement",
    ts: { $gte: since },
    vitals: { $ne: null },
  })
    .select("path vitals")
    .lean();

  const overall: Record<VitalKey, number[]> = {
    lcp: [],
    cls: [],
    inp: [],
    fcp: [],
    ttfb: [],
  };
  const perPage = new Map<string, { lcp: number[]; cls: number[]; samples: number }>();
  let samples = 0;

  for (const row of rows) {
    const v = (row as { vitals?: Partial<Record<VitalKey, number | null>> }).vitals;
    if (!v) continue;

    let carried = false;
    for (const key of KEYS) {
      const value = v[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        overall[key].push(value);
        carried = true;
      }
    }
    if (!carried) continue;
    samples++;

    const path = String(row.path ?? "/");
    const page = perPage.get(path) ?? { lcp: [], cls: [], samples: 0 };
    if (typeof v.lcp === "number") page.lcp.push(v.lcp);
    if (typeof v.cls === "number") page.cls.push(v.cls);
    page.samples++;
    perPage.set(path, page);
  }

  const metrics = Object.fromEntries(
    KEYS.map((key) => [key, summarise(overall[key], key)])
  ) as Record<VitalKey, VitalSummary>;

  const byPage = [...perPage.entries()]
    .filter(([, v]) => v.samples >= MIN_PAGE_SAMPLES)
    .map(([path, v]) => ({
      path,
      lcp: summarise(v.lcp, "lcp").p75,
      cls: summarise(v.cls, "cls").p75,
      samples: v.samples,
    }))
    // Worst LCP first: that is the page costing the most.
    .sort((a, b) => (b.lcp ?? 0) - (a.lcp ?? 0))
    .slice(0, 20);

  return {
    samples,
    days: Math.max(1, Math.round((Date.now() - since.getTime()) / 86_400_000)),
    metrics,
    byPage,
  };
}
