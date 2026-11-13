import { loadAnalytics, type AnalyticsData } from "./analytics.source.js";
import { loadForms, type FormsData } from "./forms.source.js";
import { loadSearch, type SearchData } from "./search.source.js";
import type { RadarSourceId, SourceStatus } from "../types.js";

export type RadarData = {
  now: Date;
  analytics: AnalyticsData | null;
  forms: FormsData | null;
  search: SearchData | null;
  statuses: SourceStatus[];
};

function failed(id: RadarSourceId, reason: unknown): SourceStatus {
  console.error(`[growth-radar] ${id} source failed:`, (reason as Error)?.message ?? reason);
  return { id, state: "error", detail: "This source could not be read. It will be tried again on the next scan.", freshAt: null };
}

export async function loadSources(workspaceId: string, actorId: string, now = new Date()): Promise<RadarData> {
  const [analytics, forms, search] = await Promise.allSettled([
    loadAnalytics(workspaceId, now),
    loadForms(workspaceId, actorId, now),
    loadSearch(workspaceId),
  ]);

  const analyticsResult = analytics.status === "fulfilled" ? analytics.value : null;
  const formsResult = forms.status === "fulfilled" ? forms.value : null;
  const searchResult = search.status === "fulfilled" ? search.value : null;

  return {
    now,
    analytics: analyticsResult?.data ?? null,
    forms: formsResult?.leadCapture.data ?? null,
    search: searchResult?.data ?? null,
    statuses: [
      analyticsResult?.status ?? failed("analytics", analytics.status === "rejected" ? analytics.reason : null),
      formsResult?.leadCapture.status ?? failed("leadCapture", forms.status === "rejected" ? forms.reason : null),
      formsResult?.bookings ?? failed("bookings", forms.status === "rejected" ? forms.reason : null),
      searchResult?.status ?? failed("searchConsole", search.status === "rejected" ? search.reason : null),
    ],
  };
}

export function sourceReady(data: RadarData, id: RadarSourceId): boolean {
  return data.statuses.some((s) => s.id === id && s.state === "ready");
}
