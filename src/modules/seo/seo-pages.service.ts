import { SeoReport } from "./models/SeoReport.js";
import { discoverUrls } from "./crawl.js";
import { normalizeUrl } from "./seo.service.js";

const MAX_PAGES = 300;
const SITEMAP_TTL_MS = 15 * 60 * 1000;

export type SeoPageAudit = { reportId: string; score: number; createdAt: Date };

export type SeoPage = { path: string; inSitemap: boolean; audit: SeoPageAudit | null };

export type SeoPageList = { sitemap: boolean; pages: SeoPage[] };

const sitemapCache = new Map<string, { at: number; paths: string[] }>();

export function siteOrigin(domain: string): string | null {
  const normalized = normalizeUrl(domain);
  try {
    return normalized ? new URL(normalized).origin : null;
  } catch {
    return null;
  }
}

export function pagePath(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path || "/";
  } catch {
    return null;
  }
}

async function sitemapPaths(siteId: string, origin: string): Promise<string[]> {
  const hit = sitemapCache.get(siteId);
  if (hit && Date.now() - hit.at < SITEMAP_TTL_MS) return hit.paths;
  const urls = await discoverUrls(origin).catch(() => [] as string[]);
  const paths = [...new Set(urls.map(pagePath).filter((p): p is string => Boolean(p)))];
  sitemapCache.set(siteId, { at: Date.now(), paths });
  return paths;
}

async function latestAudits(siteId: string): Promise<Map<string, SeoPageAudit>> {
  const rows = await SeoReport.aggregate<{ _id: string; reportId: unknown; score: number; createdAt: Date }>([
    { $match: { siteId } },
    { $sort: { url: 1, createdAt: -1 } },
    { $group: { _id: "$url", reportId: { $first: "$_id" }, score: { $first: "$score" }, createdAt: { $first: "$createdAt" } } },
    { $limit: MAX_PAGES },
  ]);
  const byPath = new Map<string, SeoPageAudit>();
  for (const row of rows) {
    const path = pagePath(row._id);
    if (!path) continue;
    const prev = byPath.get(path);
    if (prev && prev.createdAt >= row.createdAt) continue;
    byPath.set(path, { reportId: String(row.reportId), score: row.score ?? 0, createdAt: row.createdAt });
  }
  return byPath;
}

function byPath(a: SeoPage, b: SeoPage): number {
  if (a.path === "/") return -1;
  if (b.path === "/") return 1;
  return a.path.localeCompare(b.path);
}

export async function listSeoPages(siteId: string, origin: string): Promise<SeoPageList> {
  const [paths, audits] = await Promise.all([sitemapPaths(siteId, origin), latestAudits(siteId)]);
  const inSitemap = new Set(paths);
  const all = new Set<string>(["/", ...paths, ...audits.keys()]);
  const pages = [...all]
    .map((path) => ({ path, inSitemap: inSitemap.has(path), audit: audits.get(path) ?? null }))
    .sort(byPath)
    .slice(0, MAX_PAGES);
  return { sitemap: paths.length > 0, pages };
}
