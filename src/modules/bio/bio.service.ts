import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { appEnabled } from "../workspace/apps.service.js";
import { BioPage } from "./models/BioPage.js";
import { BioStat } from "./models/BioStat.js";
import { presentBioPage, toPublicBioPage, type BioPageStats, type PublicBioPage } from "./bio-present.js";

export const BIO_STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CachedBioPage = { page: PublicBioPage; workspaceId: string };

const statsCache = createTtlCache<Record<string, BioPageStats>>(60_000);
const publicCache = createTtlCache<CachedBioPage | null>(60_000, 500);

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function workspaceStats(workspaceId: string): Promise<Record<string, BioPageStats>> {
  return statsCache(workspaceId, async () => {
    const since = dayKey(new Date(Date.now() - (BIO_STATS_DAYS - 1) * DAY_MS));
    const rows = await BioStat.find({ workspaceId, day: { $gte: since } })
      .select("pageId views clicks")
      .limit(5000)
      .lean();
    const stats: Record<string, BioPageStats> = {};
    for (const row of rows) {
      const id = String(row.pageId);
      const entry = (stats[id] ??= { views: 0, clicks: 0, linkClicks: {} });
      entry.views += row.views ?? 0;
      for (const [linkId, n] of Object.entries((row.clicks ?? {}) as Record<string, number>)) {
        entry.clicks += n;
        entry.linkClicks[linkId] = (entry.linkClicks[linkId] ?? 0) + n;
      }
    }
    return stats;
  });
}

export async function workspaceBioPages(workspaceId: string) {
  const [pages, stats] = await Promise.all([
    BioPage.find({ workspaceId }).sort({ createdAt: 1 }).limit(250),
    workspaceStats(workspaceId),
  ]);
  return { pages: pages.map((p) => presentBioPage(p, stats[p.id])), statsDays: BIO_STATS_DAYS };
}

export function isDuplicateSlug(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

export function cachedBioPage(slug: string): Promise<CachedBioPage | null> {
  return publicCache(slug, async () => {
    const page = await BioPage.findOne({ slug, published: true });
    if (!page) return null;
    const workspace = await Workspace.findById(page.get("workspaceId")).select("apps.bio");
    if (!workspace || !appEnabled(workspace, "bio")) return null;
    return { workspaceId: String(page.get("workspaceId")), page: toPublicBioPage(presentBioPage(page)) };
  });
}

export async function publicBioPage(slug: string): Promise<PublicBioPage | null> {
  return (await cachedBioPage(slug))?.page ?? null;
}
