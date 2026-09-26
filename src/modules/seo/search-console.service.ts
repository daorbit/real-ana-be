import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  querySearchAnalytics,
  refreshSearchConsoleToken,
  type SearchAnalyticsRow,
} from "../../infra/http-client/search-console.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOP_ROWS = 50;
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

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function metricsOf(row?: SearchAnalyticsRow): Metrics {
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: row?.ctr ?? 0,
    position: row?.position ?? 0,
  };
}

export async function getSearchPerformance(input: {
  workspaceId: string;
  siteId: string;
  connectionId: string;
  propertyUrl: string;
  days: number;
  refresh?: boolean;
}): Promise<SearchPerformance> {
  const key = `performance:${input.propertyUrl}:${input.days}`;

  if (!input.refresh) {
    const cached = await SearchConsoleCache.findOne({ siteId: input.siteId, key }).lean();
    if (cached && cached.expiresAt.getTime() > Date.now()) return cached.data as SearchPerformance;
  }

  const accessToken = await usableSearchConsoleToken(input.connectionId);

  const end = new Date(Date.now() - DAY_MS);
  const start = new Date(end.getTime() - (input.days - 1) * DAY_MS);
  const previousEnd = new Date(start.getTime() - DAY_MS);
  const previousStart = new Date(previousEnd.getTime() - (input.days - 1) * DAY_MS);

  const range = { startDate: isoDay(start), endDate: isoDay(end) };

  const [totals, previous, daily, queries, pages] = await Promise.all([
    querySearchAnalytics(accessToken, input.propertyUrl, range),
    querySearchAnalytics(accessToken, input.propertyUrl, {
      startDate: isoDay(previousStart),
      endDate: isoDay(previousEnd),
    }),
    querySearchAnalytics(accessToken, input.propertyUrl, { ...range, dimensions: ["date"] }),
    querySearchAnalytics(accessToken, input.propertyUrl, {
      ...range,
      dimensions: ["query"],
      rowLimit: TOP_ROWS,
    }),
    querySearchAnalytics(accessToken, input.propertyUrl, {
      ...range,
      dimensions: ["page"],
      rowLimit: TOP_ROWS,
    }),
  ]);

  const result: SearchPerformance = {
    propertyUrl: input.propertyUrl,
    days: input.days,
    startDate: range.startDate,
    endDate: range.endDate,
    totals: metricsOf(totals[0]),
    previous: previous.length ? metricsOf(previous[0]) : null,
    daily: daily
      .map((row) => ({ date: row.keys[0] ?? "", ...metricsOf(row) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    queries: queries.map((row) => ({ query: row.keys[0] ?? "", ...metricsOf(row) })),
    pages: pages.map((row) => ({ page: row.keys[0] ?? "", ...metricsOf(row) })),
    fetchedAt: new Date().toISOString(),
  };

  await SearchConsoleCache.findOneAndUpdate(
    { siteId: input.siteId, key },
    {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      key,
      data: result,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    },
    { upsert: true },
  );

  return result;
}
