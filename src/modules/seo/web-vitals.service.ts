import {
  CRUX_METRICS,
  CruxError,
  queryCruxHistory,
  type CruxFormFactor,
  type CruxHistory,
  type CruxMetricKey,
  type CruxSeries,
} from "../../infra/http-client/crux.js";
import { AppError } from "../../shared/errors/index.js";
import { mapLimit } from "../../shared/utils/map-limit.js";
import { THRESHOLDS } from "./field-vitals.js";
import { cached, type SiteRef } from "./search-cache.js";
import { getSearchPerformance } from "./search-console.service.js";
import { propertyOrigins } from "./search-origin.js";

const VITALS_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_CONCURRENCY = 5;
const METRIC_KEYS = Object.keys(CRUX_METRICS) as CruxMetricKey[];

export type VitalsDevice = "mobile" | "desktop" | "all";
export type VitalRating = "good" | "needs-improvement" | "poor";

export type WebVital = {
  p75: number;
  previousP75: number | null;
  good: number;
  needsImprovement: number;
  poor: number;
  rating: VitalRating;
  trend: (number | null)[];
};

type VitalMap = Record<CruxMetricKey, WebVital | null>;

export type WebVitals = {
  status: "ready" | "no_data" | "not_configured";
  device: VitalsDevice;
  origin: string;
  passing: boolean | null;
  periods: string[];
  metrics: VitalMap;
  fetchedAt: string;
};

export type PageVital = { p75: number; rating: VitalRating } | null;

export type PageVitals = {
  status: "ready" | "not_configured";
  device: VitalsDevice;
  pages: Array<{ url: string; clicks: number; passing: boolean | null; lcp: PageVital; inp: PageVital; cls: PageVital }>;
  fetchedAt: string;
};

const FORM_FACTORS: Record<VitalsDevice, CruxFormFactor | null> = { mobile: "PHONE", desktop: "DESKTOP", all: null };

export function clampDevice(value: unknown): VitalsDevice {
  return value === "desktop" || value === "all" ? value : "mobile";
}

function ratingOf(key: CruxMetricKey, p75: number): VitalRating {
  const { good, poor } = THRESHOLDS[key];
  return p75 <= good ? "good" : p75 <= poor ? "needs-improvement" : "poor";
}

function percent(values: (number | null)[], index: number): number {
  return Math.round((values[index] ?? 0) * 100);
}

function vitalOf(key: CruxMetricKey, series: CruxSeries | null): WebVital | null {
  if (!series) return null;
  const latest = series.p75s.reduce<number>((found, value, index) => (value === null ? found : index), -1);
  const p75 = series.p75s[latest] ?? null;
  if (p75 === null) return null;
  const monthBefore = latest - 4;
  return {
    p75,
    previousP75: monthBefore >= 0 ? series.p75s[monthBefore] : null,
    good: percent(series.good, latest),
    needsImprovement: percent(series.needsImprovement, latest),
    poor: percent(series.poor, latest),
    rating: ratingOf(key, p75),
    trend: series.p75s,
  };
}

function vitalsOf(history: CruxHistory | null): VitalMap {
  return Object.fromEntries(
    METRIC_KEYS.map((key) => [key, vitalOf(key, history?.metrics[key] ?? null)]),
  ) as VitalMap;
}

function passes({ lcp, inp, cls }: Pick<VitalMap, "lcp" | "inp" | "cls">): boolean | null {
  if (!lcp || !cls) return null;
  return [lcp, cls, inp].every((v) => !v || v.rating === "good");
}

async function firstHistory(origins: string[], device: VitalsDevice) {
  for (const origin of origins) {
    const history = await queryCruxHistory({ origin }, FORM_FACTORS[device]);
    if (history) return { origin, history };
  }
  return { origin: origins[0] ?? "", history: null };
}

async function whenConfigured<T>(load: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!(err instanceof CruxError)) throw err;
    if (err.failure === "busy") throw new AppError(503, "Google's Web vitals data is busy. Try again in a minute.");
    console.warn(`[web-vitals] Chrome UX Report API unavailable: ${err.message}`);
    return fallback();
  }
}

export function getWebVitals(site: SiteRef, device: VitalsDevice): Promise<WebVitals> {
  const origins = propertyOrigins(site);
  const build = (status: WebVitals["status"], origin: string, history: CruxHistory | null): WebVitals => {
    const metrics = vitalsOf(history);
    return {
      status,
      device,
      origin,
      passing: passes(metrics),
      periods: history?.periods ?? [],
      metrics,
      fetchedAt: new Date().toISOString(),
    };
  };

  return whenConfigured(
    () =>
      cached(
        site,
        `vitals:${device}:${origins.join(",")}`,
        async () => {
          const { origin, history } = await firstHistory(origins, device);
          return build(history ? "ready" : "no_data", origin, history);
        },
        VITALS_TTL_MS,
      ),
    () => build("not_configured", origins[0] ?? "", null),
  );
}

function bareUrl(url: string): string {
  return url.replace(/[?#].*$/, "");
}

function pageVital(vital: WebVital | null): PageVital {
  return vital ? { p75: vital.p75, rating: vital.rating } : null;
}

async function loadPageVitals(site: SiteRef, device: VitalsDevice, days: number): Promise<PageVitals> {
  const performance = await getSearchPerformance(site, days, "web", false);
  const pages = performance.pages
    .map((page) => ({ url: bareUrl(page.page), clicks: page.clicks }))
    .filter((page, index, all) => all.findIndex((other) => other.url === page.url) === index);

  const rows = await mapLimit(pages, PAGE_CONCURRENCY, async ({ url, clicks }) => {
    const { lcp, inp, cls } = vitalsOf(await queryCruxHistory({ url }, FORM_FACTORS[device], 1));
    return {
      url,
      clicks,
      passing: passes({ lcp, inp, cls }),
      lcp: pageVital(lcp),
      inp: pageVital(inp),
      cls: pageVital(cls),
    };
  });

  return { status: "ready", device, pages: rows, fetchedAt: new Date().toISOString() };
}

export function getPageVitals(site: SiteRef, device: VitalsDevice, days: number): Promise<PageVitals> {
  return whenConfigured<PageVitals>(
    () =>
      cached(
        site,
        `vitals-pages:${device}:${days}:${site.propertyUrl}`,
        () => loadPageVitals(site, device, days),
        VITALS_TTL_MS,
      ),
    () => ({ status: "not_configured", device, pages: [], fetchedAt: new Date().toISOString() }),
  );
}
