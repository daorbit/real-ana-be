import { SearchConsoleConnection } from "../../seo/models/SearchConsoleConnection.js";
import { SearchConsoleProperty } from "../../seo/models/SearchConsoleProperty.js";
import {
  explainSearchConsoleError,
  getSearchPerformance,
  withGoogleSession,
  type SiteRef,
} from "../../seo/search-console.service.js";
import type { SourceResult } from "./analytics.source.js";

export const SEARCH_DAYS = 28;
const MAX_PROPERTIES = 3;

type Metrics = { clicks: number; impressions: number; ctr: number; position: number };

export type SearchProperty = {
  siteId: string;
  propertyUrl: string;
  startDate: string;
  endDate: string;
  totals: Metrics;
  previous: Metrics | null;
};

export type SearchData = { properties: SearchProperty[] };

function dayOf(value: string): Date | null {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function loadSearch(workspaceId: string): Promise<SourceResult<SearchData>> {
  const [connection, links] = await Promise.all([
    SearchConsoleConnection.findOne({ workspaceId }).select("_id status").lean<{ _id: unknown; status?: string }>(),
    SearchConsoleProperty.find({ workspaceId }).select("siteId propertyUrl").limit(MAX_PROPERTIES).lean(),
  ]);

  if (!connection || connection.status !== "active" || !links.length) {
    return {
      status: { id: "searchConsole", state: "not_connected", detail: "Connect Google Search Console and link a site to include search data.", freshAt: null },
      data: null,
    };
  }

  const refs: SiteRef[] = links.map((l) => ({
    workspaceId,
    siteId: String(l.siteId),
    connectionId: String(connection._id),
    propertyUrl: String(l.propertyUrl),
  }));

  try {
    const results = await Promise.all(
      refs.map((ref) => withGoogleSession(ref.connectionId, () => getSearchPerformance(ref, SEARCH_DAYS, "web", false))),
    );
    const properties = results.map((p, i) => ({
      siteId: refs[i].siteId,
      propertyUrl: p.propertyUrl,
      startDate: p.startDate,
      endDate: p.endDate,
      totals: p.totals,
      previous: p.previous,
    }));
    return {
      status: {
        id: "searchConsole",
        state: "ready",
        detail: properties.map((p) => p.propertyUrl.replace(/^sc-domain:/, "")).join(", "),
        freshAt: dayOf(properties[0]?.endDate ?? ""),
      },
      data: { properties },
    };
  } catch (e) {
    return { status: { id: "searchConsole", state: "error", detail: explainSearchConsoleError(e), freshAt: null }, data: null };
  }
}
