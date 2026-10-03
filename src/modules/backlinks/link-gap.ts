import { sourceKind, type ProfileLink, type SourceKind } from "./link-profile.js";

export type GapCompetitor = { competitorId: string; label: string };

export type GapRow = {
  domain: string;
  kind: SourceKind;
  authority: number | null;
  competitors: GapCompetitor[];
  sampleUrl: string;
  sampleAnchor: string;
};

export type LinkGap = {
  opportunities: GapRow[];
  shared: GapRow[];
  uniqueToYou: number;
};

const MAX_ROWS = 100;

export function computeLinkGap(
  mine: ProfileLink[],
  theirs: (ProfileLink & { competitorId: string })[],
  labels: Map<string, string>
): LinkGap {
  const myDomains = new Set(mine.map((l) => l.sourceDomain));
  const byDomain = new Map<string, GapRow>();

  for (const link of theirs) {
    const row = byDomain.get(link.sourceDomain) ?? {
      domain: link.sourceDomain,
      kind: sourceKind(link.sourceDomain),
      authority: link.authority,
      competitors: [],
      sampleUrl: link.sourceUrl,
      sampleAnchor: link.anchorText,
    };
    if (!row.competitors.some((c) => c.competitorId === link.competitorId)) {
      row.competitors.push({ competitorId: link.competitorId, label: labels.get(link.competitorId) ?? "" });
    }
    if (link.authority !== null && (row.authority === null || link.authority > row.authority)) {
      row.authority = link.authority;
    }
    byDomain.set(link.sourceDomain, row);
  }

  const rank = (a: GapRow, b: GapRow) =>
    b.competitors.length - a.competitors.length || (b.authority ?? -1) - (a.authority ?? -1);

  const rows = [...byDomain.values()];
  const competitorDomains = new Set(rows.map((r) => r.domain));

  return {
    opportunities: rows.filter((r) => !myDomains.has(r.domain)).sort(rank).slice(0, MAX_ROWS),
    shared: rows.filter((r) => myDomains.has(r.domain)).sort(rank).slice(0, MAX_ROWS),
    uniqueToYou: [...myDomains].filter((d) => !competitorDomains.has(d)).length,
  };
}
