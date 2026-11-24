import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  querySearchAnalytics,
  type SearchAnalyticsFilter,
  type SearchAnalyticsRow,
  type SearchType,
} from "../../infra/http-client/search-console.js";
import { typeHasQueries } from "./search-types.js";

type Period = { startDate: string; endDate: string };
type BrandTotals = { clicks: number; impressions: number; ctr: number; position: number };
type BrandPair = { branded: BrandTotals; nonBranded: BrandTotals };

export type BrandedSplit = BrandPair & { previous: BrandPair | null; since: string | null };

const BRANDED_SINCE = "2026-02-21";

function totalsOf(rows: SearchAnalyticsRow[], key: string): BrandTotals {
  const row = rows.find((r) => r.keys[0] === key);
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: row?.ctr ?? 0,
    position: row?.position ?? 0,
  };
}

function pairOf(rows: SearchAnalyticsRow[]): BrandPair | null {
  if (!rows.some((r) => r.keys[0] === "BRANDED" || r.keys[0] === "NON_BRANDED")) return null;
  return { branded: totalsOf(rows, "BRANDED"), nonBranded: totalsOf(rows, "NON_BRANDED") };
}

function canSplit(type: SearchType, filters: SearchAnalyticsFilter[]): boolean {
  return typeHasQueries(type) && !filters.some((f) => f.dimension === "query" || f.dimension === "brandedClassification");
}

export async function loadBrandedSplit(
  accessToken: string,
  propertyUrl: string,
  request: { current: Period; previous: Period; type: SearchType; filters: SearchAnalyticsFilter[] },
): Promise<BrandedSplit | null> {
  const { current, previous, type, filters } = request;
  if (!canSplit(type, filters)) return null;

  const query = (period: Period) =>
    querySearchAnalytics(accessToken, propertyUrl, {
      ...period,
      type,
      filters,
      dimensions: ["brandedClassification"],
      rowLimit: 10,
    });

  try {
    const comparable = previous.startDate >= BRANDED_SINCE;
    const [now, before] = await Promise.all([query(current), comparable ? query(previous) : Promise.resolve([])]);
    const pair = pairOf(now);
    if (!pair) return null;
    return {
      ...pair,
      previous: pairOf(before),
      since: current.startDate < BRANDED_SINCE ? BRANDED_SINCE : null,
    };
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "revoked") throw err;
    const rejected = err instanceof GoogleApiError && err.status === 400;
    if (!rejected) console.warn(`[search-console] branded split failed for ${propertyUrl}: ${(err as Error).message}`);
    return null;
  }
}
