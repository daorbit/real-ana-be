import { createHash } from "node:crypto";
import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";
import { SearchConsoleProperty } from "./models/SearchConsoleProperty.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import { badRequest } from "../../shared/errors/index.js";
import {
  inspectSearchConsoleUrl,
  listSearchConsoleSitemaps,
  querySearchAnalytics,
  refreshSearchConsoleToken,
  type SearchAnalyticsRow,
  type SearchConsoleSitemap,
  type SearchType,
  type SearchUrlInspection,
} from "../../infra/http-client/search-console.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";
import { pageViewSeries, pageViewsByPath, pathOf, type PageViewSeries } from "./search-page-views.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOP_ROWS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERFORMANCE_RANGES = [7, 28, 90, 180, 365, 480] as const;

export function clampRange(value: unknown): number {
  const days = Number(value);
  return (PERFORMANCE_RANGES as readonly number[]).includes(days) ? days : 28;
}

export async function usableSearchConsoleToken(connectionId: string): Promise<string> {
  const connection = await SearchConsoleConnection.findById(connectionId).select(
    "+accessToken +refreshToken",
  );
  if (!connection) throw new GoogleApiError("not_found", 404, "connection not found");

  const expiresAt = connection.get("expiresAt") as Date | undefined;
  if (expiresAt instanceof Date && expiresAt.getTime() > Date.now()) {
    const token = decryptSecret(String(connection.get("accessToken") ?? ""));
    if (token) return token;
  }

  const storedRefresh = decryptSecret(String(connection.get("refreshToken") ?? ""));
  if (!storedRefresh) {
    await markRevoked(connectionId, "Google did not provide a refresh token. Reconnect Search Console.");
    throw new GoogleApiError("revoked", 409, "no refresh token stored");
  }

  try {
    const tokens = await refreshSearchConsoleToken(storedRefresh);
    await SearchConsoleConnection.updateOne(
      { _id: connectionId },
      {
        accessToken: encryptSecret(tokens.accessToken),
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshToken ? { refreshToken: encryptSecret(tokens.refreshToken) } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        status: "active",
        statusMessage: "",
      },
    );
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "revoked") {
      await markRevoked(connectionId, "Google access was revoked. Reconnect Search Console.");
    }
    throw err;
  }
}

async function markRevoked(connectionId: string, message: string): Promise<void> {
  await SearchConsoleConnection.updateOne(
    { _id: connectionId },
    { status: "revoked", statusMessage: message },
  );
}

function isRevoked(err: unknown): boolean {
  return err instanceof GoogleApiError && err.kind === "revoked";
}

export async function withGoogleSession<T>(connectionId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isRevoked(err)) throw err;
  }

  await SearchConsoleConnection.updateOne({ _id: connectionId }, { expiresAt: new Date(0) });
  try {
    return await run();
  } catch (err) {
    if (isRevoked(err)) {
      await markRevoked(connectionId, "Your Google sign-in has expired. Sign in again to keep seeing search data.");
    }
    throw err;
  }
}

export function explainSearchConsoleError(err: unknown): string {
  if (!(err instanceof GoogleApiError)) return "Search Console data could not be loaded. Please try again.";

  switch (err.kind) {
    case "revoked":
      return "Google access was revoked. Reconnect Search Console to continue.";
    case "quota":
      return "Google's Search Console limit was reached. Try again in a little while.";
    case "not_enabled":
      return "The Search Console API is not enabled for this deployment's Google project.";
    case "forbidden":
      return "The connected Google account no longer has access to this Search Console property.";
    case "not_found":
      return "That Search Console property is no longer available.";
    case "unavailable":
      return "Google is temporarily unavailable. Please try again shortly.";
    default:
      return "Search Console data could not be loaded. Please try again.";
  }
}

function hostOf(value: string): string {
  return String(value)
    .trim()
    .replace(/^sc-domain:/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./i, "")
    .toLowerCase();
}

export function propertyMatchesDomain(propertyUrl: string, domain: string): boolean {
  const siteHost = hostOf(domain);
  const propertyHost = hostOf(propertyUrl);
  if (!siteHost || !propertyHost) return false;
  if (/^sc-domain:/i.test(propertyUrl)) {
    return siteHost === propertyHost || siteHost.endsWith(`.${propertyHost}`);
  }
  return siteHost === propertyHost;
}

export function isUsablePermission(permissionLevel: string): boolean {
  return permissionLevel !== "" && permissionLevel !== "siteUnverifiedUser";
}

type Metrics = { clicks: number; impressions: number; ctr: number; position: number };

export type SiteRef = {
  workspaceId: string;
  siteId: string;
  connectionId: string;
  propertyUrl: string;
};

export async function searchSiteRef(workspaceId: string, siteId: string): Promise<SiteRef | null> {
  const [link, connection] = await Promise.all([
    SearchConsoleProperty.findOne({ workspaceId, siteId }).select("propertyUrl"),
    SearchConsoleConnection.findOne({ workspaceId }).select("_id status"),
  ]);
  if (!link || !connection || connection.get("status") !== "active") return null;
  return {
    workspaceId,
    siteId,
    connectionId: String(connection._id),
    propertyUrl: String(link.get("propertyUrl")),
  };
}

export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;

const TYPES_WITHOUT_QUERIES: readonly SearchType[] = ["discover", "googleNews"];

export function clampType(value: unknown): SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(String(value)) ? (value as SearchType) : "web";
}

export function typeHasQueries(type: SearchType): boolean {
  return !TYPES_WITHOUT_QUERIES.includes(type);
}

export type SearchPerformance = {
  propertyUrl: string;
  days: number;
  type: SearchType;
  startDate: string;
  endDate: string;
  totals: Metrics;
  previous: Metrics | null;
  daily: Array<Metrics & { date: string }>;
  queries: Array<Metrics & { query: string }>;
  pages: Array<Metrics & { page: string; views?: number }>;
  fetchedAt: string;
};

export const BREAKDOWN_DIMENSIONS = ["query", "page", "country", "device"] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export type BreakdownRow = Metrics & {
  key: string;
  previousClicks: number | null;
  previousPosition: number | null;
  views?: number;
};

type BreakdownData = {
  startDate: string;
  endDate: string;
  rows: BreakdownRow[];
  lost: Array<{ key: string; previousClicks: number; previousImpressions: number }>;
  fetchedAt: string;
};

export const BREAKDOWN_SORTS = ["key", "clicks", "change", "impressions", "ctr", "position", "views"] as const;
export type BreakdownSort = (typeof BREAKDOWN_SORTS)[number];

export type BreakdownPage = {
  dimension: BreakdownDimension;
  days: number;
  type: SearchType;
  startDate: string;
  endDate: string;
  rows: BreakdownRow[];
  total: number;
  totalAll: number;
  page: number;
  pageSize: number;
  truncated: boolean;
  limitedTo: number | null;
  fetchedAt: string;
};

export type SearchSitemaps = {
  sitemaps: SearchConsoleSitemap[];
  fetchedAt: string;
};

type InsightRow = BreakdownRow & { missedClicks?: number };

export type PositionBand = {
  band: "1-3" | "4-10" | "11-20" | "21+";
  queries: number;
  clicks: number;
  impressions: number;
  netMoved: number;
};

export type SearchInsights = {
  days: number;
  type: SearchType;
  positionBands: PositionBand[];
  questionQueries: InsightRow[];
  quickWins: InsightRow[];
  lowCtr: InsightRow[];
  risingQueries: InsightRow[];
  fallingQueries: InsightRow[];
  risingPages: InsightRow[];
  fallingPages: InsightRow[];
  newQueries: InsightRow[];
  lostQueries: Array<{ key: string; previousClicks: number; previousImpressions: number }>;
  counts: { queries: number; pages: number; newQueries: number; lostQueries: number; questionQueries: number };
  limited: boolean;
  fetchedAt: string;
};

const QUESTION_QUERY =
  /^(how|what|why|when|where|which|who|whose|is|are|can|could|does|do|did|should|will|would)\b|\?$/i;

const POSITION_BANDS: Array<{ band: PositionBand["band"]; max: number }> = [
  { band: "1-3", max: 3.5 },
  { band: "4-10", max: 10.5 },
  { band: "11-20", max: 20.5 },
  { band: "21+", max: Number.POSITIVE_INFINITY },
];

function bandOf(position: number): PositionBand["band"] {
  return POSITION_BANDS.find((b) => position < b.max)!.band;
}

function positionBands(rows: BreakdownRow[]): PositionBand[] {
  const bands = new Map(
    POSITION_BANDS.map(({ band }) => [band, { band, queries: 0, clicks: 0, impressions: 0, netMoved: 0 }]),
  );
  for (const row of rows) {
    const now = bandOf(row.position);
    const current = bands.get(now)!;
    current.queries += 1;
    current.clicks += row.clicks;
    current.impressions += row.impressions;
    if (row.previousPosition === null) continue;
    const before = bandOf(row.previousPosition);
    if (before === now) continue;
    current.netMoved += 1;
    bands.get(before)!.netMoved -= 1;
  }
  return [...bands.values()];
}

export type SearchDrilldown = {
  dimension: "query" | "page";
  value: string;
  days: number;
  type: SearchType;
  totals: Metrics;
  previous: Metrics | null;
  daily: Array<Metrics & { date: string }>;
  related: Array<Metrics & { key: string }>;
  views?: PageViewSeries;
  fetchedAt: string;
};

export type SearchInspection = SearchUrlInspection & { url: string; fetchedAt: string };

const ROW_LIMITS: Record<BreakdownDimension, number> = {
  query: 25000,
  page: 25000,
  country: 250,
  device: 10,
};

const INSIGHT_ROWS = 25;

const EXPECTED_CTR = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];

function expectedCtr(position: number): number {
  const slot = Math.max(1, Math.round(position));
  return slot <= EXPECTED_CTR.length ? EXPECTED_CTR[slot - 1] : 0.01;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function periods(days: number) {
  const end = new Date(Date.now() - DAY_MS);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const previousEnd = new Date(start.getTime() - DAY_MS);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * DAY_MS);
  return {
    current: { startDate: isoDay(start), endDate: isoDay(end) },
    previous: { startDate: isoDay(previousStart), endDate: isoDay(previousEnd) },
  };
}

function metricsOf(row?: SearchAnalyticsRow): Metrics {
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: row?.ctr ?? 0,
    position: row?.position ?? 0,
  };
}

function hashKey(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

const MEMORY_ENTRIES = 60;
const memory = new Map<string, { data: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();

function remember(key: string, data: unknown, expiresAt: number) {
  memory.delete(key);
  memory.set(key, { data, expiresAt });
  while (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string);
}

async function loadCached<T>(site: SiteRef, key: string, load: () => Promise<T>, ttlMs: number): Promise<T> {
  const hit = await SearchConsoleCache.findOne({ siteId: site.siteId, key }).lean();
  if (hit && hit.expiresAt.getTime() > Date.now()) {
    remember(`${site.siteId}|${key}`, hit.data, hit.expiresAt.getTime());
    return hit.data as T;
  }

  const data = await load();
  const expiresAt = Date.now() + ttlMs;
  remember(`${site.siteId}|${key}`, data, expiresAt);
  await SearchConsoleCache.findOneAndUpdate(
    { siteId: site.siteId, key },
    {
      workspaceId: site.workspaceId,
      siteId: site.siteId,
      key,
      data,
      expiresAt: new Date(expiresAt),
    },
    { upsert: true },
  );
  return data;
}

async function cached<T>(
  site: SiteRef,
  key: string,
  load: () => Promise<T>,
  ttlMs: number = CACHE_TTL_MS,
): Promise<T> {
  const memoryKey = `${site.siteId}|${key}`;
  const hot = memory.get(memoryKey);
  if (hot && hot.expiresAt > Date.now()) return hot.data as T;

  const running = inflight.get(memoryKey);
  if (running) return running as Promise<T>;

  const pending = loadCached(site, key, load, ttlMs).finally(() => inflight.delete(memoryKey));
  inflight.set(memoryKey, pending);
  return pending;
}

export async function clearSiteCache(siteId: string): Promise<void> {
  for (const key of [...memory.keys()]) if (key.startsWith(`${siteId}|`)) memory.delete(key);
  await SearchConsoleCache.deleteMany({ siteId });
}

function loadPerformance(site: SiteRef, days: number, type: SearchType) {
  return cached(site, `performance:${type}:${site.propertyUrl}:${days}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);
    const base = { type };

    const [totals, previous, daily, queries, pages] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, { ...base, ...range.current }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...base, ...range.previous }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...base, ...range.current, dimensions: ["date"] }),
      typeHasQueries(type)
        ? querySearchAnalytics(accessToken, site.propertyUrl, {
            ...base,
            ...range.current,
            dimensions: ["query"],
            rowLimit: TOP_ROWS,
          })
        : Promise.resolve([]),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...base,
        ...range.current,
        dimensions: ["page"],
        rowLimit: TOP_ROWS,
      }),
    ]);

    return {
      propertyUrl: site.propertyUrl,
      days,
      type,
      startDate: range.current.startDate,
      endDate: range.current.endDate,
      totals: metricsOf(totals[0]),
      previous: previous.length ? metricsOf(previous[0]) : null,
      daily: daily
        .map((row) => ({ date: row.keys[0] ?? "", ...metricsOf(row) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      queries: queries.map((row) => ({ query: row.keys[0] ?? "", ...metricsOf(row) })),
      pages: pages.map((row) => ({ page: row.keys[0] ?? "", ...metricsOf(row) })),
      fetchedAt: new Date().toISOString(),
    };
  });
}

function viewsFor(site: SiteRef, days: number): Promise<Record<string, number>> {
  return cached(site, `views:${days}`, () => pageViewsByPath(site.siteId, periods(days).current));
}

export async function getSearchPerformance(
  site: SiteRef,
  days: number,
  type: SearchType,
  withViews = true,
): Promise<SearchPerformance> {
  const [performance, views] = await Promise.all([
    loadPerformance(site, days, type),
    withViews ? viewsFor(site, days) : Promise.resolve(null),
  ]);
  if (!views) return performance;
  return {
    ...performance,
    pages: performance.pages.map((p) => ({ ...p, views: views[pathOf(p.page)] ?? 0 })),
  };
}

function loadBreakdown(
  site: SiteRef,
  dimension: BreakdownDimension,
  days: number,
  type: SearchType,
): Promise<BreakdownData> {
  if (dimension === "query" && !typeHasQueries(type)) {
    const range = periods(days).current;
    return Promise.resolve({ ...range, rows: [], lost: [], fetchedAt: new Date().toISOString() });
  }

  return cached(site, `breakdown:${type}:${dimension}:${site.propertyUrl}:${days}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);
    const rowLimit = ROW_LIMITS[dimension];

    const [current, previous] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.current,
        type,
        dimensions: [dimension],
        rowLimit,
      }),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.previous,
        type,
        dimensions: [dimension],
        rowLimit,
      }),
    ]);

    const before = new Map(previous.map((row) => [row.keys[0] ?? "", row]));
    const seen = new Set<string>();

    const rows = current.map((row) => {
      const key = row.keys[0] ?? "";
      seen.add(key);
      const earlier = before.get(key);
      return {
        key,
        ...metricsOf(row),
        previousClicks: earlier ? earlier.clicks : null,
        previousPosition: earlier ? earlier.position : null,
      };
    });

    const lost = previous
      .filter((row) => !seen.has(row.keys[0] ?? "") && row.clicks > 0)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 100)
      .map((row) => ({
        key: row.keys[0] ?? "",
        previousClicks: row.clicks,
        previousImpressions: row.impressions,
      }));

    return {
      startDate: range.current.startDate,
      endDate: range.current.endDate,
      rows,
      lost,
      fetchedAt: new Date().toISOString(),
    };
  });
}

function changeOf(row: BreakdownRow): number {
  if (row.previousClicks === null) return Number.POSITIVE_INFINITY;
  if (!row.previousClicks) return row.clicks ? Number.POSITIVE_INFINITY : 0;
  return (row.clicks - row.previousClicks) / row.previousClicks;
}

export async function getSearchBreakdownPage(
  site: SiteRef,
  dimension: BreakdownDimension,
  days: number,
  type: SearchType,
  options: {
    page: number;
    pageSize: number;
    sort: BreakdownSort;
    desc: boolean;
    q: string;
    rowLimit?: number | null;
    withViews?: boolean;
  },
): Promise<BreakdownPage> {
  const [data, views] = await Promise.all([
    loadBreakdown(site, dimension, days, type),
    dimension === "page" && options.withViews !== false ? viewsFor(site, days) : Promise.resolve(null),
  ]);
  const q = options.q.trim().toLowerCase();

  const limit = options.rowLimit && data.rows.length > options.rowLimit ? options.rowLimit : null;
  const allowed = limit ? [...data.rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, limit) : data.rows;
  const rows = views ? allowed.map((row) => ({ ...row, views: views[pathOf(row.key)] ?? 0 })) : allowed;
  const filtered = q ? rows.filter((row) => row.key.toLowerCase().includes(q)) : rows;

  const value = (row: BreakdownRow): number | string =>
    options.sort === "key"
      ? row.key.toLowerCase()
      : options.sort === "change"
        ? changeOf(row)
        : options.sort === "views"
          ? (row.views ?? 0)
          : row[options.sort];

  const sorted = [...filtered].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    const cmp = typeof av === "string" ? av.localeCompare(String(bv)) : av - (bv as number);
    return options.desc ? -cmp : cmp;
  });

  const pageSize = Math.min(Math.max(options.pageSize, 10), 200);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(options.page, 1), pages);

  return {
    dimension,
    days,
    type,
    startDate: data.startDate,
    endDate: data.endDate,
    rows: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    totalAll: data.rows.length,
    limitedTo: limit,
    page,
    pageSize,
    truncated: data.rows.length >= ROW_LIMITS[dimension],
    fetchedAt: data.fetchedAt,
  };
}

export async function getSearchInsights(
  site: SiteRef,
  days: number,
  type: SearchType,
  limit: number = INSIGHT_ROWS,
): Promise<SearchInsights> {
  const [queries, pages] = await Promise.all([
    loadBreakdown(site, "query", days, type),
    loadBreakdown(site, "page", days, type),
  ]);

  const top = <T>(list: T[], score: (item: T) => number) =>
    [...list].sort((a, b) => score(b) - score(a)).slice(0, limit);

  const clickDelta = (row: BreakdownRow) => row.clicks - (row.previousClicks ?? 0);

  const quickWins = top(
    queries.rows.filter((row) => row.position >= 4 && row.position <= 20 && row.impressions >= 10),
    (row) => row.impressions,
  );

  const lowCtr = top(
    queries.rows
      .filter((row) => row.impressions >= 50 && row.position <= 10)
      .map((row) => ({ ...row, missedClicks: Math.round(row.impressions * expectedCtr(row.position) - row.clicks) }))
      .filter((row) => row.missedClicks > 0),
    (row) => row.missedClicks ?? 0,
  );

  const withHistory = (rows: BreakdownRow[]) => rows.filter((row) => row.previousClicks !== null);
  const newQueries = queries.rows.filter((row) => row.previousClicks === null && row.clicks > 0);
  const questionQueries = queries.rows.filter((row) => QUESTION_QUERY.test(row.key.trim()));

  return {
    days,
    type,
    positionBands: positionBands(queries.rows),
    questionQueries: top(questionQueries, (row) => row.impressions),
    quickWins,
    lowCtr,
    risingQueries: top(withHistory(queries.rows).filter((r) => clickDelta(r) > 0), clickDelta),
    fallingQueries: top(withHistory(queries.rows).filter((r) => clickDelta(r) < 0), (r) => -clickDelta(r)),
    risingPages: top(withHistory(pages.rows).filter((r) => clickDelta(r) > 0), clickDelta),
    fallingPages: top(withHistory(pages.rows).filter((r) => clickDelta(r) < 0), (r) => -clickDelta(r)),
    newQueries: top(newQueries, (row) => row.clicks),
    lostQueries: queries.lost.slice(0, limit),
    counts: {
      queries: queries.rows.length,
      pages: pages.rows.length,
      newQueries: newQueries.length,
      lostQueries: queries.lost.length,
      questionQueries: questionQueries.length,
    },
    limited: limit < INSIGHT_ROWS,
    fetchedAt: queries.fetchedAt,
  };
}

export function getSearchDrilldown(
  site: SiteRef,
  dimension: "query" | "page",
  value: string,
  days: number,
  type: SearchType,
): Promise<SearchDrilldown> {
  if (dimension === "query" && !typeHasQueries(type)) {
    return Promise.reject(badRequest("Google does not report queries for this search type"));
  }

  return cached(site, `drill:${type}:${dimension}:${days}:${hashKey(`${site.propertyUrl}|${value}`)}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);
    const filters = [{ dimension, operator: "equals" as const, expression: value }];
    const counterpart = dimension === "query" ? "page" : "query";

    const [totals, previous, daily, related, views] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.current, type, filters }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.previous, type, filters }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.current, type, filters, dimensions: ["date"] }),
      counterpart === "query" && !typeHasQueries(type)
        ? Promise.resolve([])
        : querySearchAnalytics(accessToken, site.propertyUrl, {
            ...range.current,
            type,
            filters,
            dimensions: [counterpart],
            rowLimit: 50,
          }),
      dimension === "page"
        ? pageViewSeries(site.siteId, value, range.current, range.previous)
        : Promise.resolve(undefined),
    ]);

    return {
      dimension,
      value,
      days,
      type,
      totals: metricsOf(totals[0]),
      previous: previous.length ? metricsOf(previous[0]) : null,
      daily: daily
        .map((row) => ({ date: row.keys[0] ?? "", ...metricsOf(row) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      related: related.map((row) => ({ key: row.keys[0] ?? "", ...metricsOf(row) })),
      views,
      fetchedAt: new Date().toISOString(),
    };
  });
}

const HOURLY_TTL_MS = 30 * 60 * 1000;
const HOURLY_WINDOW = 48;
const HOUR_MS = 60 * 60 * 1000;

export type SearchHourly = {
  type: SearchType;
  hours: Array<Metrics & { hour: string }>;
  last24: Metrics;
  previous24: Metrics | null;
  fetchedAt: string;
};

function sumMetrics(rows: Metrics[]): Metrics {
  const clicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  const weighted = rows.reduce((sum, r) => sum + r.position * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weighted / impressions : 0,
  };
}

function hourlySeries(rows: SearchAnalyticsRow[]): Array<Metrics & { hour: string }> {
  const byHour = new Map<number, Metrics>();
  for (const row of rows) {
    const at = Date.parse(row.keys[0] ?? "");
    if (Number.isFinite(at)) byHour.set(at, metricsOf(row));
  }
  if (!byHour.size) return [];

  const latest = Math.max(...byHour.keys());
  return Array.from({ length: HOURLY_WINDOW }, (_, i) => {
    const at = latest - (HOURLY_WINDOW - 1 - i) * HOUR_MS;
    return { hour: new Date(at).toISOString(), ...(byHour.get(at) ?? metricsOf()) };
  });
}

export function getSearchHourly(site: SiteRef, type: SearchType): Promise<SearchHourly> {
  return cached(
    site,
    `hourly:${type}:${site.propertyUrl}`,
    async () => {
      const accessToken = await usableSearchConsoleToken(site.connectionId);
      const now = new Date();
      const rows = await querySearchAnalytics(accessToken, site.propertyUrl, {
        startDate: isoDay(new Date(now.getTime() - 3 * DAY_MS)),
        endDate: isoDay(now),
        type,
        dimensions: ["hour"],
        dataState: "hourly_all",
        rowLimit: 500,
      });

      const hours = hourlySeries(rows);
      const previous = hours.slice(0, hours.length - 24);
      return {
        type,
        hours,
        last24: sumMetrics(hours.slice(-24)),
        previous24: previous.length ? sumMetrics(previous) : null,
        fetchedAt: now.toISOString(),
      };
    },
    HOURLY_TTL_MS,
  );
}

function sitemapsKey(site: SiteRef): string {
  return `sitemaps:${site.propertyUrl}`;
}

export function getSearchSitemaps(site: SiteRef): Promise<SearchSitemaps> {
  return cached(site, sitemapsKey(site), async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const sitemaps = await listSearchConsoleSitemaps(accessToken, site.propertyUrl);
    return { sitemaps, fetchedAt: new Date().toISOString() };
  });
}

export async function forgetSearchSitemaps(site: SiteRef): Promise<void> {
  const key = sitemapsKey(site);
  memory.delete(`${site.siteId}|${key}`);
  await SearchConsoleCache.deleteOne({ siteId: site.siteId, key });
}
function inspectionKey(site: SiteRef, url: string) {
  return `inspect:${hashKey(`${site.propertyUrl}|${url}`)}`;
}

export async function isInspectionCached(site: SiteRef, url: string): Promise<boolean> {
  const key = inspectionKey(site, url);
  const hot = memory.get(`${site.siteId}|${key}`);
  if (hot && hot.expiresAt > Date.now()) return true;
  const hit = await SearchConsoleCache.findOne({ siteId: site.siteId, key }).select("expiresAt").lean();
  return Boolean(hit && hit.expiresAt.getTime() > Date.now());
}

export function getSearchInspection(site: SiteRef, url: string): Promise<SearchInspection> {
  return cached(site, inspectionKey(site, url), async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const inspection = await inspectSearchConsoleUrl(accessToken, site.propertyUrl, url);
    return { ...inspection, url, fetchedAt: new Date().toISOString() };
  });
}
