import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { BioStat, BIO_COUNTER_FIELDS, type BioCounterField } from "./models/BioStat.js";
import { decodeKey } from "./bio-keys.js";
import { dayKey } from "./bio.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 800;
const TOP = 12;

type Counts = Record<string, number>;
type StatRow = { day: string; views?: number; visitors?: number; clicks?: Counts; hours?: Counts } & Partial<Record<BioCounterField, Counts>>;
type Tracked = { id: string; label: string };

export type BioStatsDetail = {
  days: number;
  maxDays: number;
  views: number;
  visitors: number;
  clicks: number;
  previous: { views: number; visitors: number; clicks: number } | null;
  daily: Array<{ date: string; views: number; visitors: number; clicks: number }>;
  links: Array<{ id: string; label: string; clicks: number }>;
  heatmap: Array<{ day: number; hour: number; count: number }>;
} & Record<BioCounterField, Array<{ key: string; count: number }>>;

const cache = createTtlCache<StatRow[]>(60_000, 300);

function sumCounts(counts: Counts | undefined): number {
  return Object.values(counts ?? {}).reduce((total, n) => total + n, 0);
}

function addInto(target: Counts, counts: Counts | undefined, decode = false) {
  for (const [key, n] of Object.entries(counts ?? {})) {
    const k = decode ? decodeKey(key) : key;
    target[k] = (target[k] ?? 0) + n;
  }
}

function ranked(counts: Counts): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP);
}

function loadRows(pageId: string, days: number): Promise<StatRow[]> {
  const since = dayKey(new Date(Date.now() - (days * 2 - 1) * DAY_MS));
  return cache(`${pageId}:${days}`, () =>
    BioStat.find({ pageId, day: { $gte: since } })
      .select(["day", "views", "visitors", "clicks", "hours", ...BIO_COUNTER_FIELDS].join(" "))
      .sort({ day: 1 })
      .limit(MAX_ROWS)
      .lean<StatRow[]>()
      .exec(),
  );
}

function dailySeries(rows: Map<string, StatRow>, days: number) {
  const series: BioStatsDetail["daily"] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = dayKey(new Date(Date.now() - i * DAY_MS));
    const row = rows.get(date);
    series.push({ date, views: row?.views ?? 0, visitors: row?.visitors ?? 0, clicks: sumCounts(row?.clicks) });
  }
  return series;
}

export async function bioPageStats(pageId: string, tracked: Tracked[], days: number, maxDays: number): Promise<BioStatsDetail> {
  const all = await loadRows(pageId, days);
  const cutoff = dayKey(new Date(Date.now() - (days - 1) * DAY_MS));
  const current = all.filter((r) => r.day >= cutoff);
  const before = all.filter((r) => r.day < cutoff);

  const linkClicks: Counts = {};
  const counters = Object.fromEntries(BIO_COUNTER_FIELDS.map((f) => [f, {} as Counts])) as Record<BioCounterField, Counts>;
  const heat: Counts = {};

  for (const row of current) {
    addInto(linkClicks, row.clicks);
    for (const field of BIO_COUNTER_FIELDS) addInto(counters[field], row[field], true);
    const weekday = new Date(`${row.day}T00:00:00Z`).getUTCDay();
    for (const [hour, n] of Object.entries(row.hours ?? {})) {
      const key = `${weekday}-${hour}`;
      heat[key] = (heat[key] ?? 0) + n;
    }
  }

  const daily = dailySeries(new Map(current.map((r) => [r.day, r])), days);
  const total = (key: "views" | "visitors" | "clicks", list: typeof daily) => list.reduce((sum, p) => sum + p[key], 0);
  const previous = before.length
    ? {
        views: before.reduce((sum, r) => sum + (r.views ?? 0), 0),
        visitors: before.reduce((sum, r) => sum + (r.visitors ?? 0), 0),
        clicks: before.reduce((sum, r) => sum + sumCounts(r.clicks), 0),
      }
    : null;

  return {
    days,
    maxDays,
    views: total("views", daily),
    visitors: total("visitors", daily),
    clicks: total("clicks", daily),
    previous,
    daily,
    links: tracked.map((t) => ({ id: t.id, label: t.label, clicks: linkClicks[t.id] ?? 0 })).sort((a, b) => b.clicks - a.clicks),
    heatmap: Object.entries(heat).map(([key, count]) => {
      const [day, hour] = key.split("-").map(Number);
      return { day, hour, count };
    }),
    ...(Object.fromEntries(BIO_COUNTER_FIELDS.map((f) => [f, ranked(counters[f])])) as Record<BioCounterField, Array<{ key: string; count: number }>>),
  };
}
