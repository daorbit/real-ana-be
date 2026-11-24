import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import { mapLimit } from "../../shared/utils/map-limit.js";
import { discoverUrls } from "./crawl.js";
import { cached, type SiteRef } from "./search-cache.js";
import { clampRange, explainSearchConsoleError, getSearchBreakdownPage } from "./search-console.service.js";
import { SearchPlanDenied, type SearchEntitlement } from "./search-entitlements.js";
import {
  failedIndexCheck,
  indexCheckOf,
  loadIndexChecks,
  saveIndexCheck,
  type IndexCheck,
} from "./search-index-checks.js";
import { inspectPage } from "./search-inspections.service.js";
import { propertyOrigins } from "./search-origin.js";
import { sitemapInProperty } from "./search-sitemaps.service.js";

const MAX_PAGES = 500;
const SEARCH_PAGES = 200;
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 4;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredCheck = Omit<IndexCheck, "url">;

export type IndexPage = {
  url: string;
  inSitemap: boolean;
  clicks: number | null;
  check: StoredCheck | null;
};

export type SearchIndexing = { pages: IndexPage[]; sitemapPages: number; days: number };

export type IndexCheckRun = {
  checks: IndexCheck[];
  remaining: number;
  stopped: string | null;
  outOfChecks: boolean;
};

function sitemapUrls(site: SiteRef): Promise<string[]> {
  const [origin] = propertyOrigins(site);
  if (!origin) return Promise.resolve([]);
  return cached(site, `sitemap-urls:${origin}:${site.propertyUrl}`, async () => {
    const urls = await discoverUrls(origin).catch((err: unknown) => {
      console.warn(`[search-indexing] sitemap of ${origin} could not be read: ${(err as Error)?.message}`);
      return [] as string[];
    });
    return urls.filter((url) => sitemapInProperty(site.propertyUrl, url)).slice(0, MAX_PAGES);
  });
}

async function searchPages(site: SiteRef, ent: SearchEntitlement, days: number): Promise<Map<string, number>> {
  const { rows } = await getSearchBreakdownPage(site, "page", days, "web", {
    page: 1,
    pageSize: SEARCH_PAGES,
    sort: "clicks",
    desc: true,
    q: "",
    rowLimit: ent.rowLimit,
    withViews: false,
  });
  return new Map(
    rows
      .filter((row) => !row.key.includes("#") && sitemapInProperty(site.propertyUrl, row.key))
      .map((row) => [row.key, row.clicks]),
  );
}

function storedCheck(check: IndexCheck | undefined): StoredCheck | null {
  if (!check) return null;
  const { state, reason, lastCrawled, richResults, checkedAt } = check;
  return { state, reason, lastCrawled, richResults, checkedAt };
}

export async function getSearchIndexing(site: SiteRef, ent: SearchEntitlement): Promise<SearchIndexing> {
  const days = clampRange(Math.min(28, ent.maxDays));
  const [listed, found, checks] = await Promise.all([
    sitemapUrls(site),
    searchPages(site, ent, days),
    loadIndexChecks(site),
  ]);

  const inSitemap = new Set(listed);
  const urls = [...new Set([...found.keys(), ...listed, ...checks.keys()])].slice(0, MAX_PAGES);
  const pages = urls.map((url) => ({
    url,
    inSitemap: inSitemap.has(url),
    clicks: found.get(url) ?? null,
    check: storedCheck(checks.get(url)),
  }));
  return { pages, sitemapPages: listed.length, days };
}

function checkQueue(pages: IndexPage[]): string[] {
  const unchecked = pages.filter((page) => !page.check);
  const age = (page: IndexPage) => Date.now() - Date.parse(page.check?.checkedAt ?? "");
  const stale = pages.filter((page) => page.check && age(page) > STALE_MS).sort((a, b) => age(b) - age(a));
  return [
    ...unchecked.filter((page) => page.clicks === null),
    ...unchecked.filter((page) => page.clicks !== null),
    ...stale,
  ].map((page) => page.url);
}

function failsOnlyThisPage(err: unknown): boolean {
  return err instanceof GoogleApiError && ["forbidden", "not_found", "unknown"].includes(err.kind);
}

export async function checkNextPages(site: SiteRef, ent: SearchEntitlement, count: number): Promise<IndexCheckRun> {
  const { pages } = await getSearchIndexing(site, ent);
  const queue = checkQueue(pages);
  const batch = queue.slice(0, Math.min(Math.max(count, 1), BATCH_SIZE));

  const checks: IndexCheck[] = [];
  const stops: unknown[] = [];

  await mapLimit(batch, BATCH_CONCURRENCY, async (url) => {
    if (stops.length) return;
    try {
      checks.push(indexCheckOf(await inspectPage(site, ent, url)));
    } catch (err) {
      if (!failsOnlyThisPage(err)) {
        stops.push(err);
        return;
      }
      const failed = failedIndexCheck(url);
      await saveIndexCheck(site, failed);
      checks.push(failed);
    }
  });

  const stop = stops[0];
  const signedOut = stop instanceof GoogleApiError && stop.kind === "revoked";
  if (stop && (signedOut || !checks.length)) throw stop;

  const denied = stop instanceof SearchPlanDenied ? stop : null;
  return {
    checks,
    remaining: Math.max(0, queue.length - checks.length),
    stopped: denied ? denied.message : stop ? explainSearchConsoleError(stop) : null,
    outOfChecks: Boolean(denied),
  };
}
