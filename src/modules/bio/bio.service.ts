import type { IncomingHttpHeaders } from "node:http";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { classifyRequest } from "../analytics/bot-detect.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { appEnabled } from "../workspace/apps.service.js";
import { BioPage } from "./models/BioPage.js";
import { BIO_STAT_RETENTION_MS, BioStat } from "./models/BioStat.js";

export const BIO_STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type BioPageDoc = InstanceType<typeof BioPage>;
type LinkStats = Record<string, number>;
export type BioPageStats = { views: number; clicks: number; linkClicks: LinkStats };

export type PublicBioPage = {
  id: string;
  slug: string;
  title: string;
  bio: string;
  avatarUrl: string;
  links: Array<{ id: string; label: string; url: string }>;
  socials: Array<{ network: string; url: string }>;
  theme: { appearance: string; accent: string; buttonStyle: string };
};

const statsCache = createTtlCache<Record<string, BioPageStats>>(60_000);
type CachedBioPage = { page: PublicBioPage; workspaceId: string };

const publicCache = createTtlCache<CachedBioPage | null>(60_000, 500);

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function linksOf(doc: BioPageDoc) {
  return ((doc.get("links") as Array<{ _id: unknown; label: string; url: string; enabled: boolean }>) ?? []).map((link) => ({
    id: String(link._id),
    label: link.label,
    url: link.url,
    enabled: link.enabled !== false,
  }));
}

export function presentBioPage(doc: BioPageDoc, stats?: BioPageStats) {
  return {
    id: doc.id as string,
    slug: doc.get("slug") as string,
    title: doc.get("title") as string,
    bio: (doc.get("bio") as string) ?? "",
    avatarUrl: (doc.get("avatarUrl") as string) ?? "",
    links: linksOf(doc),
    socials: ((doc.get("socials") as Array<{ network: string; url: string }>) ?? []).map((s) => ({ network: s.network, url: s.url })),
    theme: {
      appearance: doc.get("theme.appearance") as string,
      accent: doc.get("theme.accent") as string,
      buttonStyle: doc.get("theme.buttonStyle") as string,
    },
    published: doc.get("published") as boolean,
    stats: stats ?? { views: 0, clicks: 0, linkClicks: {} },
    updatedAt: doc.get("updatedAt") as Date,
  };
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
    BioPage.find({ workspaceId }).sort({ createdAt: 1 }).limit(100),
    workspaceStats(workspaceId),
  ]);
  return { pages: pages.map((p) => presentBioPage(p, stats[p.id])), statsDays: BIO_STATS_DAYS };
}

export function isDuplicateSlug(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

function cachedBioPage(slug: string): Promise<CachedBioPage | null> {
  return publicCache(slug, async () => {
    const page = await BioPage.findOne({ slug, published: true });
    if (!page) return null;
    const workspace = await Workspace.findById(page.get("workspaceId")).select("apps.bio");
    if (!workspace || !appEnabled(workspace, "bio")) return null;
    const present = presentBioPage(page);
    return {
      workspaceId: String(page.get("workspaceId")),
      page: {
        id: present.id,
        slug: present.slug,
        title: present.title,
        bio: present.bio,
        avatarUrl: present.avatarUrl,
        links: present.links.filter((link) => link.enabled).map(({ id, label, url }) => ({ id, label, url })),
        socials: present.socials,
        theme: present.theme,
      },
    };
  });
}

export async function publicBioPage(slug: string): Promise<PublicBioPage | null> {
  return (await cachedBioPage(slug))?.page ?? null;
}

function isAutomated(userAgent: string, headers: IncomingHttpHeaders): boolean {
  return classifyRequest(userAgent, headers) !== null;
}

async function bump(cached: CachedBioPage, inc: Record<string, number>) {
  const now = new Date();
  await BioStat.updateOne(
    { pageId: cached.page.id, day: dayKey(now) },
    { $inc: inc, $setOnInsert: { workspaceId: cached.workspaceId, expiresAt: new Date(now.getTime() + BIO_STAT_RETENTION_MS) } },
    { upsert: true },
  );
}

export async function recordBioView(slug: string, userAgent: string, headers: IncomingHttpHeaders): Promise<void> {
  if (isAutomated(userAgent, headers)) return;
  const cached = await cachedBioPage(slug);
  if (cached) await bump(cached, { views: 1 });
}

export async function recordBioClick(
  slug: string,
  linkId: string,
  userAgent: string,
  headers: IncomingHttpHeaders,
): Promise<string | null> {
  const cached = await cachedBioPage(slug);
  const link = cached?.page.links.find((l) => l.id === linkId);
  if (!cached || !link) return null;
  if (!isAutomated(userAgent, headers)) {
    await bump(cached, { [`clicks.${link.id}`]: 1 }).catch((e: Error) => console.error("[bio] click not recorded:", e.message));
  }
  return link.url;
}
