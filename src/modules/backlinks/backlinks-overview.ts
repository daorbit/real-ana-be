import { backlinkIndexConfigured } from "../../infra/http-client/backlink-index.js";
import { Backlink } from "./models/Backlink.js";
import { CompetitorBacklink } from "./models/CompetitorBacklink.js";
import { buildProfile, type ProfileLink } from "./link-profile.js";
import { computeLinkGap } from "./link-gap.js";
import type { LinkRel } from "./link-scan.js";
import { trackedCompetitors, type SiteRef } from "./backlinks.service.js";

const DAY = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 30;
const TOP_PAGES = 10;

type StoredLink = {
  sourceUrl: string;
  sourceDomain: string;
  targetUrl?: string | null;
  anchorText?: string | null;
  rel?: string | null;
  isImage?: boolean | null;
  authority?: number | null;
};

function toProfileLink(l: StoredLink): ProfileLink {
  return {
    sourceUrl: l.sourceUrl,
    sourceDomain: l.sourceDomain,
    anchorText: l.anchorText ?? "",
    rel: (l.rel ?? "follow") as LinkRel,
    isImage: Boolean(l.isImage),
    authority: l.authority ?? null,
  };
}

function pathOf(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
}

function topLinkedPages(links: StoredLink[]) {
  const pages = new Map<string, { url: string; links: number; domains: Set<string> }>();
  for (const { targetUrl, sourceDomain } of links) {
    if (!targetUrl) continue;
    const path = pathOf(targetUrl);
    const page = pages.get(path) ?? { url: targetUrl, links: 0, domains: new Set<string>() };
    page.links++;
    page.domains.add(sourceDomain);
    pages.set(path, page);
  }
  return [...pages]
    .map(([path, page]) => ({ path, url: page.url, links: page.links, domains: page.domains.size }))
    .sort((a, b) => b.domains - a.domains || b.links - a.links)
    .slice(0, TOP_PAGES);
}

export async function buildOverview(site: SiteRef) {
  const [mine, competitors, theirs] = await Promise.all([
    Backlink.find({ siteId: site.siteId }).lean(),
    trackedCompetitors(site.siteId),
    CompetitorBacklink.find({ siteId: site.siteId, status: "live" }).lean(),
  ]);

  const since = Date.now() - RECENT_DAYS * DAY;
  const live = mine.filter((b) => b.status === "live");
  const liveLinks = live.map(toProfileLink);
  const myProfile = buildProfile(liveLinks, site.domain);

  const competitorLinks = theirs.map((t) => ({ ...toProfileLink(t), competitorId: String(t.competitorId) }));
  const labels = new Map(competitors.map((c) => [c.competitorId, c.label]));
  const gap = computeLinkGap(liveLinks, competitorLinks, labels);

  return {
    indexAvailable: backlinkIndexConfigured(),
    topPages: topLinkedPages(live),
    summary: {
      total: mine.length,
      live: live.length,
      referringDomains: myProfile.referringDomains,
      followShare: myProfile.followShare,
      lost: mine.filter((b) => b.status === "lost" || b.status === "page-gone").length,
      lostRecently: mine.filter((b) => b.lostAt && b.lostAt.getTime() >= since).length,
      newRecently: live.filter((b) => b.createdAt && new Date(b.createdAt).getTime() >= since).length,
      awaiting: mine.filter((b) => b.status === "pending" || b.status === "unverified" || b.status === "unreachable").length,
      referralVisits: mine.reduce((sum, b) => sum + (b.referralVisits ?? 0), 0),
      opportunities: gap.opportunities.length,
    },
    profiles: {
      mine: myProfile,
      competitors: competitors.map((c) => ({
        competitorId: c.competitorId,
        label: c.label,
        domain: c.domain,
        profile: buildProfile(
          competitorLinks.filter((l) => l.competitorId === c.competitorId),
          c.domain
        ),
      })),
    },
    gap,
  };
}
