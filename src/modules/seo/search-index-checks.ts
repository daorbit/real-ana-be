import { hashKey, loadLasting, saveLasting, type SiteRef } from "./search-cache.js";
import type { SearchInspection } from "./search-console.service.js";

const CHECK_PREFIX = "index:";
const CHECK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CHECKS = 2000;

export type IndexState = "indexed" | "not_indexed" | "blocked" | "failed";

export type IndexCheck = {
  url: string;
  state: IndexState;
  reason: string;
  lastCrawled: string | null;
  richResults: Array<{ type: string; issues: number }>;
  checkedAt: string;
};

function stateOf({ verdict, coverageState }: SearchInspection): IndexState {
  const coverage = (coverageState ?? "").toLowerCase();
  if (verdict === "PASS" || (coverage.includes("indexed") && !coverage.includes("not indexed"))) return "indexed";
  return /blocked|noindex|robots/.test(coverage) ? "blocked" : "not_indexed";
}

export function indexCheckOf(inspection: SearchInspection): IndexCheck {
  return {
    url: inspection.url,
    state: stateOf(inspection),
    reason: inspection.coverageState || inspection.indexStatus,
    lastCrawled: inspection.lastCrawled ?? null,
    richResults: (inspection.richResults ?? []).map((r) => ({ type: r.type, issues: r.issues.length })),
    checkedAt: inspection.fetchedAt,
  };
}

export function failedIndexCheck(url: string): IndexCheck {
  return {
    url,
    state: "failed",
    reason: "Google couldn't inspect this address",
    lastCrawled: null,
    richResults: [],
    checkedAt: new Date().toISOString(),
  };
}

export function saveIndexCheck(site: SiteRef, check: IndexCheck): Promise<void> {
  return saveLasting(site, `${CHECK_PREFIX}${hashKey(check.url)}`, check, CHECK_TTL_MS);
}

export async function loadIndexChecks(site: SiteRef): Promise<Map<string, IndexCheck>> {
  const checks = await loadLasting<IndexCheck>(site, CHECK_PREFIX, MAX_CHECKS);
  return new Map(checks.map((check) => [check.url, check]));
}
