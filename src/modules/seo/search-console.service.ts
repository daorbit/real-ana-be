import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  listSearchConsoleSitemaps,
  querySearchAnalytics,
  refreshSearchConsoleToken,
  type SearchAnalyticsRow,
  type SearchConsoleSitemap,
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

export type SearchPerformance = {
  propertyUrl: string;
  days: number;
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

export type SearchBreakdown = {
  dimension: BreakdownDimension;
  days: number;
  startDate: string;
  endDate: string;
  rows: Array<Metrics & { key: string; previousClicks: number | null; previousPosition: number | null }>;
  fetchedAt: string;
};

export type SearchSitemaps = {
  sitemaps: SearchConsoleSitemap[];
  fetchedAt: string;
};

const ROW_LIMITS: Record<BreakdownDimension, number> = {
  query: 1000,
  page: 1000,
  country: 250,
  device: 10,
};

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

export function getSearchPerformance(site: SiteRef, days: number): Promise<SearchPerformance> {
  return cached(site, `performance:${site.propertyUrl}:${days}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);

    const [totals, previous, daily, queries, pages] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, range.current),
      querySearchAnalytics(accessToken, site.propertyUrl, range.previous),
      querySearchAnalytics(accessToken, site.propertyUrl, { ...range.current, dimensions: ["date"] }),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.current,
        dimensions: ["query"],
        rowLimit: TOP_ROWS,
      }),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.current,
        dimensions: ["page"],
        rowLimit: TOP_ROWS,
      }),
    ]);

    return {
      propertyUrl: site.propertyUrl,
      days,
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

export function getSearchBreakdown(
  site: SiteRef,
  dimension: BreakdownDimension,
  days: number,
): Promise<SearchBreakdown> {
  return cached(site, `breakdown:${dimension}:${site.propertyUrl}:${days}`, async () => {
    const accessToken = await usableSearchConsoleToken(site.connectionId);
    const range = periods(days);
    const rowLimit = ROW_LIMITS[dimension];

    const [current, previous] = await Promise.all([
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.current,
        dimensions: [dimension],
        rowLimit,
      }),
      querySearchAnalytics(accessToken, site.propertyUrl, {
        ...range.previous,
        dimensions: [dimension],
        rowLimit,
      }),
    ]);

    const before = new Map(previous.map((row) => [row.keys[0] ?? "", row]));

    return {
      dimension,
      days,
      startDate: range.current.startDate,
      endDate: range.current.endDate,
      rows: current.map((row) => {
        const key = row.keys[0] ?? "";
        const earlier = before.get(key);
        return {
          key,
          ...metricsOf(row),
          previousClicks: earlier ? earlier.clicks : null,
          previousPosition: earlier ? earlier.position : null,
        };
      }),
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