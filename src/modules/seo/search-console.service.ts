import { createHash } from "node:crypto";
import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  inspectSearchConsoleUrl,
  listSearchConsoleSitemaps,
  querySearchAnalytics,
  refreshSearchConsoleToken,
  type SearchAnalyticsRow,
  type SearchConsoleSitemap,
  type SearchType,
} from "../../infra/http-client/search-console.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";

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
    throw new GoogleApiError("revoked", 401, "no refresh token stored");
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

export const SEARCH_TYPES = ["web", "image", "video", "news"] as const;

export function clampType(value: unknown): SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(String(value)) ? (value as SearchType) : "web";
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
  pages: Array<Metrics & { page: string }>;
  fetchedAt: string;
};

export const BREAKDOWN_DIMENSIONS = ["query", "page", "country", "device"] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export type BreakdownRow = Metrics & {
  key: string;
  previousClicks: number | null;
  previousPosition: number | null;
};

type BreakdownData = {
  startDate: string;
  endDate: string;
  rows: BreakdownRow[];
  lost: Array<{ key: string; previousClicks: number; previousImpressions: number }>;
  fetchedAt: string;
};

export const BREAKDOWN_SORTS = ["key", "clicks", "change", "impressions", "ctr", "position"] as const;
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
  fetchedAt: string;
};

export type SearchSitemaps = {
  sitemaps: SearchConsoleSitemap[];
  fetchedAt: string;
};

type InsightRow = BreakdownRow & { missedClicks?: number };

export type SearchInsights = {
  days: number;
  type: SearchType;
  quickWins: InsightRow[];
  lowCtr: InsightRow[];
  risingQueries: InsightRow[];
  fallingQueries: InsightRow[];
  risingPages: InsightRow[];
  fallingPages: InsightRow[];
  newQueries: InsightRow[];
  lostQueries: Array<{ key: string; previousClicks: number; previousImpressions: number }>;
  counts: { queries: number; pages: number; newQueries: number; lostQueries: number };
  fetchedAt: string;
};

export type SearchDrilldown = {
  dimension: "query" | "page";
  value: string;
  days: number;
  type: SearchType;
  totals: Metrics;
  previous: Metrics | null;
  daily: Array<Metrics & { date: string }>;
  related: Array<Metrics & { key: string }>;
  indexStatus?: string;
  coverageState?: string;
  pageFetchState?: string;
  robotsTxtState?: string;
  lastCrawled?: string | null;
  issues?: Array<{ severity: string; message: string; type?: string }>;
  fetchedAt: string;
};

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

async function cached<T>(site: SiteRef, key: string, load: () => Promise<T>): Promise<T> {
  const hit = await SearchConsoleCache.findOne({ siteId: site.siteId, key }).lean();
  if (hit && hit.expiresAt.getTime() > Date.now()) return hit.data as T;

  const data = await load();
  await SearchConsoleCache.findOneAndUpdate(
    { siteId: site.siteId, key },
    {
      workspaceId: site.workspaceId,
      siteId: site.siteId,
      key,
      data,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    },
    { upsert: true },
  );
  return data;
}

export async function clearSiteCache(siteId: string): Promise<void> {
  await SearchConsoleCache.deleteMany({ siteId });
}

export function getSearchPerformance(site: SiteRef, days: number, type: SearchType): Promise<SearchPerformance> {
  return cached(site, `performance:${type}:${site.propertyUrl}:${days}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);
    const base = { type };

    const [totals, previous, daily, queries, pages] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, { ...base, ...range.current }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...base, ...range.previous }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...base, ...range.current, dimensions: ["date"] }),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...base,
        ...range.current,
        dimensions: ["query"],
        rowLimit: TOP_ROWS,
      }),
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

function loadBreakdown(
  site: SiteRef,
  dimension: BreakdownDimension,
  days: number,
  type: SearchType,
): Promise<BreakdownData> {
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
  options: { page: number; pageSize: number; sort: BreakdownSort; desc: boolean; q: string },
): Promise<BreakdownPage> {
  const data = await loadBreakdown(site, dimension, days, type);
  const q = options.q.trim().toLowerCase();

  const filtered = q ? data.rows.filter((row) => row.key.toLowerCase().includes(q)) : data.rows;

  const value = (row: BreakdownRow): number | string =>
    options.sort === "key" ? row.key.toLowerCase() : options.sort === "change" ? changeOf(row) : row[options.sort];

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
    page,
    pageSize,
    truncated: data.rows.length >= ROW_LIMITS[dimension],
    fetchedAt: data.fetchedAt,
  };
}

export async function getSearchInsights(site: SiteRef, days: number, type: SearchType): Promise<SearchInsights> {
  const [queries, pages] = await Promise.all([
    loadBreakdown(site, "query", days, type),
    loadBreakdown(site, "page", days, type),
  ]);

  const top = <T>(list: T[], score: (item: T) => number) =>
    [...list].sort((a, b) => score(b) - score(a)).slice(0, INSIGHT_ROWS);

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

  return {
    days,
    type,
    quickWins,
    lowCtr,
    risingQueries: top(withHistory(queries.rows).filter((r) => clickDelta(r) > 0), clickDelta),
    fallingQueries: top(withHistory(queries.rows).filter((r) => clickDelta(r) < 0), (r) => -clickDelta(r)),
    risingPages: top(withHistory(pages.rows).filter((r) => clickDelta(r) > 0), clickDelta),
    fallingPages: top(withHistory(pages.rows).filter((r) => clickDelta(r) < 0), (r) => -clickDelta(r)),
    newQueries: top(newQueries, (row) => row.clicks),
    lostQueries: queries.lost.slice(0, INSIGHT_ROWS),
    counts: {
      queries: queries.rows.length,
      pages: pages.rows.length,
      newQueries: newQueries.length,
      lostQueries: queries.lost.length,
    },
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
  return cached(site, `drill:${type}:${dimension}:${days}:${hashKey(`${site.propertyUrl}|${value}`)}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);
    const filters = [{ dimension, operator: "equals" as const, expression: value }];
    const counterpart = dimension === "query" ? "page" : "query";

    const [totals, previous, daily, related, inspection] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.current, type, filters }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.previous, type, filters }),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.current, type, filters, dimensions: ["date"] }),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.current,
        type,
        filters,
        dimensions: [counterpart],
        rowLimit: 50,
      }),
      dimension === "page" ? inspectSearchConsoleUrl(accessToken, site.propertyUrl, value) : Promise.resolve(null),
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
      indexStatus: inspection?.indexStatus,
      coverageState: inspection?.coverageState,
      pageFetchState: inspection?.pageFetchState,
      robotsTxtState: inspection?.robotsTxtState,
      lastCrawled: inspection?.lastCrawled ?? null,
      issues: inspection?.issues ?? [],
      fetchedAt: new Date().toISOString(),
    };
  });
}

export function getSearchSitemaps(site: SiteRef): Promise<SearchSitemaps> {
  return cached(site, `sitemaps:${site.propertyUrl}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const sitemaps = await listSearchConsoleSitemaps(accessToken, site.propertyUrl);
    return { sitemaps, fetchedAt: new Date().toISOString() };
  });
}