import { fetchIndexedBacklinks, type IndexedLink } from "../../infra/http-client/backlink-index.js";
import { Backlink } from "./models/Backlink.js";
import { CompetitorBacklink } from "./models/CompetitorBacklink.js";
import { checkSource, nextStatus } from "./verify.js";
import { parseRel, type FoundLink } from "./link-scan.js";
import { hostOf } from "./domains.js";
import {
  recordCompetitorLinks, trackedCompetitors, type SiteRef,
} from "./backlinks.service.js";

export type PageCheckResult = {
  url: string;
  httpStatus: number;
  you: FoundLink | null;
  competitors: { competitorId: string; label: string; domain: string; link: FoundLink | null }[];
};

function linkFromIndex(i: IndexedLink) {
  return {
    sourceUrl: i.sourceUrl,
    sourceDomain: i.sourceDomain,
    targetUrl: i.targetUrl,
    anchorText: i.anchorText,
    rel: i.dofollow ? "follow" : parseRel(i.attributes.join(" ") || "nofollow", false),
    isImage: i.isImage,
    authority: i.authority,
  };
}

export async function checkPage(site: SiteRef, url: string): Promise<PageCheckResult> {
  const competitors = await trackedCompetitors(site.siteId);
  const outcome = await checkSource(url, site.domain, competitors);
  if (outcome.httpStatus === null) throw new Error(outcome.error || "could not fetch that page");

  if (outcome.found) {
    const next = nextStatus({ status: "pending", lastLiveAt: null, lostAt: null }, outcome);
    await Backlink.updateOne(
      { siteId: site.siteId, sourceUrl: url },
      {
        $set: { ...outcome.found, ...next, httpStatus: outcome.httpStatus, lastCheckedAt: new Date(), lastError: "" },
        $setOnInsert: { workspaceId: site.workspaceId, sourceDomain: hostOf(url) ?? "", origin: "scan" },
      },
      { upsert: true }
    );
  }
  await recordCompetitorLinks(site, url, outcome, competitors);

  const byId = new Map(outcome.competitorLinks.map((c) => [c.competitorId, c.link]));
  return {
    url,
    httpStatus: outcome.httpStatus,
    you: outcome.found,
    competitors: competitors.map((c) => ({ ...c, link: byId.get(c.competitorId) ?? null })),
  };
}

export async function syncFromIndex(site: SiteRef) {
  const now = new Date();
  const mine = (await fetchIndexedBacklinks(site.domain)).map(linkFromIndex);

  if (mine.length) {
    await Backlink.bulkWrite(
      mine.map((l) => ({
        updateOne: {
          filter: { siteId: site.siteId, sourceUrl: l.sourceUrl },
          update: {
            $set: { authority: l.authority },
            $setOnInsert: {
              workspaceId: site.workspaceId,
              sourceDomain: l.sourceDomain,
              targetUrl: l.targetUrl,
              anchorText: l.anchorText,
              rel: l.rel,
              isImage: l.isImage,
              origin: "index",
              status: "live",
              lastLiveAt: now,
            },
          },
          upsert: true,
        },
      }))
    );
  }

  const competitors = await trackedCompetitors(site.siteId);
  const results: { competitorId: string; label: string; links: number; error: string }[] = [];
  for (const c of competitors) {
    try {
      const links = (await fetchIndexedBacklinks(c.domain)).map(linkFromIndex);
      if (links.length) {
        await CompetitorBacklink.bulkWrite(
          links.map((l) => ({
            updateOne: {
              filter: { competitorId: c.competitorId, sourceUrl: l.sourceUrl },
              update: {
                $set: { ...l, status: "live", lastSeenAt: now },
                $setOnInsert: { workspaceId: site.workspaceId, siteId: site.siteId, origin: "index" },
              },
              upsert: true,
            },
          }))
        );
      }
      results.push({ competitorId: c.competitorId, label: c.label, links: links.length, error: "" });
    } catch (e) {
      results.push({ competitorId: c.competitorId, label: c.label, links: 0, error: (e as Error)?.message ?? "failed" });
    }
  }

  return { mine: mine.length, competitors: results };
}

export async function listCompetitorLinks(siteId: string, competitorId: string) {
  return CompetitorBacklink.find({ siteId, competitorId })
    .sort({ status: 1, authority: -1, lastSeenAt: -1 })
    .limit(500)
    .lean();
}
