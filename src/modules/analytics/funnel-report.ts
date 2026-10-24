export type FunnelStep = { type: "page" | "event"; value: string };

export type TrendUnit = "5min" | "hour" | "day" | "week";

export type FunnelTotals = {
  counts: number[];
  avgMsFromPrev: (number | null)[];
};

export type FunnelBucket = { at: number; entered: number; completed: number };

export type FunnelReportStep = {
  label: string;
  type: "page" | "event";
  count: number;
  rate: number;
  stepRate: number;
  dropFromPrev: number;
  dropped: number;
  avgSecondsFromPrev: number | null;
  previousCount: number | null;
};

export type FunnelTrendPoint = { at: string; entered: number; completed: number; conversion: number };

export type FunnelPeriod = { since: string; until: string; entered: number; completed: number; conversion: number };

export type FunnelReport = {
  steps: FunnelReportStep[];
  current: FunnelPeriod;
  previous: FunnelPeriod | null;
  trend: { unit: TrendUnit; points: FunnelTrendPoint[] };
  biggestDrop: { index: number; dropped: number; dropFromPrev: number } | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TREND_UNIT_MS: Record<TrendUnit, number> = {
  "5min": 5 * MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
};

export function trendUnitFor(windowMs: number): TrendUnit {
  if (windowMs <= 3 * HOUR) return "5min";
  if (windowMs <= 2 * DAY) return "hour";
  if (windowMs <= 92 * DAY) return "day";
  return "week";
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function fillTrend(buckets: FunnelBucket[], since: Date, until: Date, unit: TrendUnit): FunnelTrendPoint[] {
  const size = TREND_UNIT_MS[unit];
  const byStart = new Map(buckets.map((b) => [b.at, b]));
  const points: FunnelTrendPoint[] = [];
  const first = Math.floor(since.getTime() / size) * size;
  for (let at = first; at < until.getTime(); at += size) {
    const bucket = byStart.get(at);
    const entered = bucket?.entered ?? 0;
    const completed = bucket?.completed ?? 0;
    points.push({ at: new Date(at).toISOString(), entered, completed, conversion: percent(completed, entered) });
  }
  return points;
}

function period(totals: FunnelTotals, since: Date, until: Date): FunnelPeriod {
  const entered = totals.counts[0] ?? 0;
  const completed = totals.counts[totals.counts.length - 1] ?? 0;
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    entered,
    completed,
    conversion: percent(completed, entered),
  };
}

export function buildFunnelReport(input: {
  steps: FunnelStep[];
  current: FunnelTotals;
  previous: FunnelTotals | null;
  buckets: FunnelBucket[];
  window: { since: Date; until: Date; prevSince: Date; prevUntil: Date };
  unit: TrendUnit;
}): FunnelReport {
  const { steps, current, previous, buckets, window, unit } = input;
  const entered = current.counts[0] ?? 0;

  const reportSteps: FunnelReportStep[] = steps.map((step, i) => {
    const count = current.counts[i] ?? 0;
    const before = i === 0 ? count : (current.counts[i - 1] ?? 0);
    const avgMs = current.avgMsFromPrev[i];
    return {
      label: step.value,
      type: step.type,
      count,
      rate: i === 0 ? (count > 0 ? 100 : 0) : percent(count, entered),
      stepRate: i === 0 ? (count > 0 ? 100 : 0) : percent(count, before),
      dropFromPrev: i === 0 || before === 0 ? 0 : Math.round((100 - percent(count, before)) * 10) / 10,
      dropped: i === 0 ? 0 : Math.max(0, before - count),
      avgSecondsFromPrev: i === 0 || avgMs === null || avgMs === undefined ? null : Math.round(avgMs / 1000),
      previousCount: previous ? (previous.counts[i] ?? 0) : null,
    };
  });

  let biggestDrop: FunnelReport["biggestDrop"] = null;
  reportSteps.forEach((step, index) => {
    if (index === 0 || step.dropped <= 0) return;
    if (biggestDrop && step.dropped <= biggestDrop.dropped) return;
    biggestDrop = { index, dropped: step.dropped, dropFromPrev: step.dropFromPrev };
  });

  return {
    steps: reportSteps,
    current: period(current, window.since, window.until),
    previous: previous ? period(previous, window.prevSince, window.prevUntil) : null,
    trend: { unit, points: fillTrend(buckets, window.since, window.until, unit) },
    biggestDrop,
  };
}

export type FunnelOverviewRow = {
  id: string;
  entered: number;
  completed: number;
  conversion: number;
  previousConversion: number | null;
  biggestDrop: FunnelReport["biggestDrop"];
};

export function overviewRow(id: string, report: FunnelReport): FunnelOverviewRow {
  return {
    id,
    entered: report.current.entered,
    completed: report.current.completed,
    conversion: report.current.conversion,
    previousConversion: report.previous?.conversion ?? null,
    biggestDrop: report.biggestDrop,
  };
}

export function funnelCacheKey(parts: {
  workspaceId: string;
  siteIds: string[];
  steps: FunnelStep[];
  since: Date;
  until: Date;
  compare: boolean;
  rangeKey: string;
}): string {
  const live = parts.rangeKey !== "custom";
  const bound = (d: Date) => (live ? Math.floor(d.getTime() / MINUTE) : d.getTime());
  return [
    parts.workspaceId,
    [...parts.siteIds].sort().join(","),
    parts.steps.map((s) => `${s.type}:${s.value}`).join("|"),
    parts.rangeKey,
    bound(parts.since),
    bound(parts.until),
    parts.compare ? "cmp" : "solo",
  ].join("#");
}
