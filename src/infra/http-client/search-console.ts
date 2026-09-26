import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleGetJson,
  googlePostJson,
  refreshGoogleToken,
  revokeGoogleToken,
  type GoogleClientConfig,
  type GoogleTokens,
} from "./google-oauth.js";

const WEBMASTERS_API = "https://www.googleapis.com/webmasters/v3";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

const REQUESTED_SCOPES = ["openid", "email", SEARCH_CONSOLE_SCOPE].join(" ");

function config(): GoogleClientConfig {
  return {
    clientId: process.env.GOOGLE_GSC_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_GSC_CLIENT_SECRET ?? "",
    redirectUri: searchConsoleRedirectUri(),
  };
}

export function searchConsoleRedirectUri(): string {
  return (
    process.env.GOOGLE_GSC_REDIRECT_URI ??
    `${process.env.PUBLIC_BASE_URL ?? "http://localhost:4000"}/api/auth/search-console/callback`
  );
}

export function missingSearchConsoleConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.GOOGLE_GSC_CLIENT_ID) missing.push("GOOGLE_GSC_CLIENT_ID");
  if (!process.env.GOOGLE_GSC_CLIENT_SECRET) missing.push("GOOGLE_GSC_CLIENT_SECRET");
  if (!searchConsoleRedirectUri()) missing.push("GOOGLE_GSC_REDIRECT_URI");
  return missing;
}

export function buildSearchConsoleAuthorizeUrl(state: string): string {
  return buildGoogleAuthorizeUrl(config(), REQUESTED_SCOPES, state);
}

export function exchangeSearchConsoleCode(code: string): Promise<GoogleTokens> {
  return exchangeGoogleCode(config(), code);
}

export function refreshSearchConsoleToken(refreshToken: string): Promise<GoogleTokens> {
  return refreshGoogleToken(config(), refreshToken);
}

export function revokeSearchConsoleToken(token: string): Promise<void> {
  return revokeGoogleToken(token, "search-console");
}

export function hasSearchConsoleScope(scope: string): boolean {
  return scope.split(/\s+/).includes(SEARCH_CONSOLE_SCOPE);
}

export async function fetchGoogleProfile(
  accessToken: string,
): Promise<{ sub: string; email: string } | null> {
  try {
    const data = await googleGetJson<{ sub?: string; email?: string }>(USERINFO_URL, accessToken);
    return data.sub ? { sub: data.sub, email: data.email ?? "" } : null;
  } catch {
    return null;
  }
}

export type SearchConsoleSite = {
  siteUrl: string;
  permissionLevel: string;
};

export async function listSearchConsoleSites(accessToken: string): Promise<SearchConsoleSite[]> {
  const data = await googleGetJson<{
    siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  }>(`${WEBMASTERS_API}/sites`, accessToken);

  return (data.siteEntry ?? [])
    .filter((entry) => entry.siteUrl)
    .map((entry) => ({
      siteUrl: String(entry.siteUrl),
      permissionLevel: String(entry.permissionLevel ?? ""),
    }));
}

export type SearchConsoleSitemap = {
  path: string;
  type: string;
  isIndex: boolean;
  isPending: boolean;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  errors: number;
  warnings: number;
  submitted: number;
  indexed: number;
};

export async function listSearchConsoleSitemaps(
  accessToken: string,
  siteUrl: string,
): Promise<SearchConsoleSitemap[]> {
  const data = await googleGetJson<{
    sitemap?: Array<{
      path?: string;
      type?: string;
      isSitemapsIndex?: boolean;
      isPending?: boolean;
      lastSubmitted?: string;
      lastDownloaded?: string;
      errors?: string | number;
      warnings?: string | number;
      contents?: Array<{ type?: string; submitted?: string | number; indexed?: string | number }>;
    }>;
  }>(`${WEBMASTERS_API}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, accessToken);

  return (data.sitemap ?? [])
    .filter((entry) => entry.path)
    .map((entry) => {
      const contents = entry.contents ?? [];
      return {
        path: String(entry.path),
        type: String(entry.type ?? ""),
        isIndex: Boolean(entry.isSitemapsIndex),
        isPending: Boolean(entry.isPending),
        lastSubmitted: entry.lastSubmitted ?? null,
        lastDownloaded: entry.lastDownloaded ?? null,
        errors: Number(entry.errors ?? 0),
        warnings: Number(entry.warnings ?? 0),
        submitted: contents.reduce((sum, c) => sum + Number(c.submitted ?? 0), 0),
        indexed: contents.reduce((sum, c) => sum + Number(c.indexed ?? 0), 0),
      };
    });
}

export type SearchAnalyticsDimension = "date" | "query" | "page" | "country" | "device";

export type SearchAnalyticsRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SearchType = "web" | "image" | "video" | "news";

export type SearchAnalyticsFilter = {
  dimension: "query" | "page" | "country" | "device";
  operator: "equals" | "contains";
  expression: string;
};

export type SearchUrlInspectionIssue = {
  severity: string;
  message: string;
  type?: string;
};

export type SearchUrlInspection = {
  indexStatus: string;
  coverageState?: string;
  pageFetchState?: string;
  robotsTxtState?: string;
  lastCrawled?: string | null;
  issues: SearchUrlInspectionIssue[];
};

function normalizeGoogleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["state", "text", "value", "date", "time", "isoDate", "formatted", "seconds"]) {
      const candidate = obj[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
      if (typeof candidate === "number") return String(candidate);
    }
    if (typeof obj.seconds === "number") return new Date(obj.seconds * 1000).toISOString();
  }
  return "";
}

export async function inspectSearchConsoleUrl(
  accessToken: string,
  siteUrl: string,
  pageUrl: string,
): Promise<SearchUrlInspection> {
  const data = await googlePostJson<{
    inspectionResult?: {
      inspectionStatus?: unknown;
      indexStatusResult?: {
        coverageState?: unknown;
        indexingState?: unknown;
        pageFetchState?: unknown;
        robotsTxtState?: unknown;
        lastCrawlTime?: unknown;
      };
      issues?: Array<{
        severity?: string;
        message?: string;
        type?: string;
      }>;
    };
  }>(
    "https://searchconsole.googleapis.com/v1/urlInspection.index:inspect",
    accessToken,
    { inspectionUrl: pageUrl, siteUrl },
  );

  const inspection = data.inspectionResult ?? {};
  const index = inspection.indexStatusResult ?? {};
  const statusState = normalizeGoogleValue(
    (inspection.inspectionStatus as { state?: unknown } | undefined)?.state ?? inspection.inspectionStatus,
  );
  const rawStatus = normalizeGoogleValue(
    index.coverageState ?? index.indexingState ?? (statusState || "unknown"),
  );
  const issues = (inspection.issues ?? [])
    .filter((issue) => issue.message)
    .map((issue) => ({
      severity: String(issue.severity ?? "info"),
      message: String(issue.message),
      type: issue.type ? String(issue.type) : undefined,
    }));

  const indexStatus =
    rawStatus === "INDEXED"
      ? "Indexed in Google search"
      : rawStatus === "PARTIALLY_INDEXED"
        ? "Partially indexed"
        : rawStatus === "URL_NOT_IN_INDEX"
          ? "Not indexed"
          : rawStatus === "DISALLOWED"
            ? "Blocked by robots or directives"
            : rawStatus === "CRAWLED"
              ? "Crawled by Google"
              : rawStatus === "notFound"
                ? "Page not found"
                : rawStatus === "unknown" || rawStatus === ""
                  ? "No recent index signal"
                  : rawStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    indexStatus,
    coverageState: normalizeGoogleValue(index.coverageState) || undefined,
    pageFetchState: normalizeGoogleValue(index.pageFetchState) || undefined,
    robotsTxtState: normalizeGoogleValue(index.robotsTxtState) || undefined,
    lastCrawled: normalizeGoogleValue(index.lastCrawlTime) || null,
    issues,
  };
}

export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  request: {
    startDate: string;
    endDate: string;
    dimensions?: SearchAnalyticsDimension[];
    rowLimit?: number;
    startRow?: number;
    type?: SearchType;
    filters?: SearchAnalyticsFilter[];
  },
): Promise<SearchAnalyticsRow[]> {
  const data = await googlePostJson<{
    rows?: Array<{
      keys?: string[];
      clicks?: number;
      impressions?: number;
      ctr?: number;
      position?: number;
    }>;
  }>(
    `${WEBMASTERS_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    accessToken,
    {
      startDate: request.startDate,
      endDate: request.endDate,
      dimensions: request.dimensions ?? [],
      rowLimit: request.rowLimit ?? 1000,
      startRow: request.startRow ?? 0,
      type: request.type ?? "web",
      dataState: "all",
      ...(request.filters?.length
        ? { dimensionFilterGroups: [{ groupType: "and", filters: request.filters }] }
        : {}),
    },
  );

  return (data.rows ?? []).map((row) => ({
    keys: row.keys ?? [],
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    ctr: Number(row.ctr ?? 0),
    position: Number(row.position ?? 0),
  }));
}
