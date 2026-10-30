export type InsightTone = "good" | "bad" | "info";

export type Insight = {
  id: string;
  kind: "traffic" | "engagement" | "source" | "page" | "country" | "device" | "campaign";
  tone: InsightTone;
  title: string;
  body: string;
  dimension: string;
  key: string;
  current: number;
  previous: number;
  delta: number | null;
  unit: string;
  score: number;
};

export type Totals = { visitors: number; pageviews: number; bounceRate: number; avgSessionMs: number };

export type BreakdownRow = { key: string; count: number; previous: number; delta: number | null };

export type DetectInput = {
  totals: { current: Totals; previous: Totals };
  referrers: BreakdownRow[];
  pages: BreakdownRow[];
  countries: BreakdownRow[];
  devices: BreakdownRow[];
  campaigns: BreakdownRow[];
};

const MIN_VISITORS = 30;
const TRAFFIC_SWING = 20;
const BOUNCE_SWING = 8;
const ROW_MIN = 15;
const NEW_MIN = 10;
const ROW_SWING = 50;
const MOBILE_SWING = 10;
const MAX_INSIGHTS = 8;

const pct = (current: number, previous: number) =>
  previous === 0 ? null : Math.round(((current - previous) / previous) * 100);

const fmt = (n: number) => n.toLocaleString("en-US");

const IGNORED_KEYS = new Set(["(none)", "(direct)", "(unknown)", ""]);

function traffic({ current, previous }: DetectInput["totals"]): Insight[] {
  if (Math.max(current.visitors, previous.visitors) < MIN_VISITORS) return [];
  const change = pct(current.visitors, previous.visitors);
  if (change === null || Math.abs(change) < TRAFFIC_SWING) return [];
  const up = change > 0;
  return [
    {
      id: "traffic",
      kind: "traffic",
      tone: up ? "good" : "bad",
      title: up ? `Visitors up ${change}% this week` : `Visitors down ${Math.abs(change)}% this week`,
      body: `${fmt(current.visitors)} visitors, against ${fmt(previous.visitors)} the week before.`,
      dimension: "",
      key: "",
      current: current.visitors,
      previous: previous.visitors,
      delta: change,
      unit: "visitors",
      score: 100 + Math.abs(change),
    },
  ];
}

function engagement({ current, previous }: DetectInput["totals"]): Insight[] {
  if (current.visitors < MIN_VISITORS || previous.visitors < MIN_VISITORS) return [];
  const diff = current.bounceRate - previous.bounceRate;
  if (Math.abs(diff) < BOUNCE_SWING) return [];
  const worse = diff > 0;
  return [
    {
      id: "bounce",
      kind: "engagement",
      tone: worse ? "bad" : "good",
      title: worse ? `More visitors leaving after one page` : `Fewer visitors leaving after one page`,
      body: `Bounce rate moved from ${previous.bounceRate}% to ${current.bounceRate}%.`,
      dimension: "",
      key: "",
      current: current.bounceRate,
      previous: previous.bounceRate,
      delta: diff,
      unit: "points",
      score: 70 + Math.abs(diff) * 2,
    },
  ];
}

function rows(
  list: BreakdownRow[],
  kind: Insight["kind"],
  dimension: string,
  copy: { fresh: (key: string, n: number) => string; up: (key: string, d: number) => string; down: (key: string, d: number) => string; unit: string },
  weight: number,
): Insight[] {
  const out: Insight[] = [];
  for (const row of list) {
    if (IGNORED_KEYS.has(row.key)) continue;
    const base = { kind, dimension, key: row.key, current: row.count, previous: row.previous, unit: copy.unit };
    if (row.previous === 0 && row.count >= NEW_MIN) {
      out.push({
        ...base,
        id: `${kind}:new:${row.key}`,
        tone: "good",
        title: copy.fresh(row.key, row.count),
        body: `${fmt(row.count)} ${copy.unit} this week, none the week before.`,
        delta: null,
        score: weight + 20 + Math.min(row.count, 200) / 4,
      });
      continue;
    }
    const change = pct(row.count, row.previous);
    if (change === null || Math.max(row.count, row.previous) < ROW_MIN || Math.abs(change) < ROW_SWING) continue;
    const up = change > 0;
    out.push({
      ...base,
      id: `${kind}:${up ? "up" : "down"}:${row.key}`,
      tone: up ? "good" : "bad",
      title: up ? copy.up(row.key, change) : copy.down(row.key, Math.abs(change)),
      body: `${fmt(row.count)} ${copy.unit} this week, against ${fmt(row.previous)} the week before.`,
      delta: change,
      score: weight + Math.min(Math.abs(change), 300) / 6 + Math.min(Math.max(row.count, row.previous), 300) / 10,
    });
  }
  return out;
}

function mobileShift(devices: BreakdownRow[]): Insight[] {
  const total = (pick: (r: BreakdownRow) => number) => devices.reduce((s, r) => s + pick(r), 0);
  const now = total((r) => r.count);
  const before = total((r) => r.previous);
  if (now < MIN_VISITORS || before < MIN_VISITORS) return [];
  const mobile = devices.find((r) => r.key.toLowerCase() === "mobile");
  if (!mobile) return [];
  const shareNow = Math.round((mobile.count / now) * 100);
  const shareBefore = Math.round((mobile.previous / before) * 100);
  const diff = shareNow - shareBefore;
  if (Math.abs(diff) < MOBILE_SWING) return [];
  return [
    {
      id: "device:mobile",
      kind: "device",
      tone: "info",
      title: diff > 0 ? `Mobile now ${shareNow}% of your traffic` : `Mobile share fell to ${shareNow}%`,
      body:
        diff > 0
          ? `Up from ${shareBefore}% the week before. Check that key pages work well on a phone.`
          : `Down from ${shareBefore}% the week before.`,
      dimension: "device",
      key: "mobile",
      current: shareNow,
      previous: shareBefore,
      delta: diff,
      unit: "% share",
      score: 55 + Math.abs(diff),
    },
  ];
}

export function detectInsights(input: DetectInput): Insight[] {
  const found = [
    ...traffic(input.totals),
    ...engagement(input.totals),
    ...rows(input.referrers, "source", "referrer", {
      fresh: (k, n) => `New source: ${k} sent ${fmt(n)} visits`,
      up: (k, d) => `${k} is sending ${d}% more visits`,
      down: (k, d) => `${k} is sending ${d}% fewer visits`,
      unit: "visits",
    }, 80),
    ...rows(input.pages, "page", "path", {
      fresh: (k, n) => `${k} took off with ${fmt(n)} views`,
      up: (k, d) => `${k} views up ${d}%`,
      down: (k, d) => `${k} views down ${d}%`,
      unit: "views",
    }, 60),
    ...rows(input.countries, "country", "country", {
      fresh: (k, n) => `First visitors from ${k}: ${fmt(n)} views`,
      up: (k, d) => `Traffic from ${k} up ${d}%`,
      down: (k, d) => `Traffic from ${k} down ${d}%`,
      unit: "views",
    }, 40),
    ...rows(input.campaigns, "campaign", "utmSource", {
      fresh: (k, n) => `Campaign source ${k} started: ${fmt(n)} visits`,
      up: (k, d) => `Campaign source ${k} up ${d}%`,
      down: (k, d) => `Campaign source ${k} down ${d}%`,
      unit: "visits",
    }, 50),
    ...mobileShift(input.devices),
  ];
  return found.sort((a, b) => b.score - a.score).slice(0, MAX_INSIGHTS);
}
