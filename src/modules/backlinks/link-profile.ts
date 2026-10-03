import type { LinkRel } from "./link-scan.js";
import { brandTokens } from "./domains.js";

export type ProfileLink = {
  sourceUrl: string;
  sourceDomain: string;
  anchorText: string;
  rel: LinkRel;
  isImage: boolean;
  authority: number | null;
};

export type AnchorKind = "branded" | "keyword" | "url" | "generic" | "image";
export type SourceKind = "editorial" | "directory" | "community" | "social";

export type ProfileInsight = {
  id: string;
  tone: "strength" | "risk" | "neutral";
  title: string;
  detail: string;
};

export type LinkProfile = {
  totalLinks: number;
  referringDomains: number;
  followShare: number;
  avgAuthority: number | null;
  rel: Record<LinkRel, number>;
  anchors: Record<AnchorKind, number>;
  sources: Record<SourceKind, number>;
  topAnchors: { text: string; count: number; kind: AnchorKind }[];
  topDomains: { domain: string; links: number; authority: number | null; kind: SourceKind }[];
  insights: ProfileInsight[];
};

const GENERIC_ANCHORS = new Set([
  "click here", "here", "this", "link", "website", "site", "web site", "homepage", "home page",
  "read more", "learn more", "more", "visit", "visit site", "visit website", "source", "view",
  "this post", "this article", "this page", "official site", "official website", "go", "check it out",
]);

const SOURCE_PATTERNS: { kind: SourceKind; hosts: RegExp }[] = [
  {
    kind: "social",
    hosts: /(^|\.)(twitter\.com|x\.com|t\.co|facebook\.com|fb\.com|linkedin\.com|lnkd\.in|instagram\.com|pinterest\.[a-z.]+|youtube\.com|youtu\.be|tiktok\.com|threads\.net|bsky\.app|mastodon\.social)$/,
  },
  {
    kind: "community",
    hosts: /(^|\.)(reddit\.com|quora\.com|stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|dev\.to|indiehackers\.com|github\.com|discord\.com|discourse\.org|lobste\.rs|hashnode\.dev)$/,
  },
  {
    kind: "directory",
    hosts: /(^|\.)(g2\.com|capterra\.[a-z.]+|producthunt\.com|crunchbase\.com|trustpilot\.com|yelp\.[a-z.]+|clutch\.co|alternativeto\.net|getapp\.com|softwareadvice\.com|saashub\.com|bbb\.org|yellowpages\.[a-z.]+|justdial\.com|sitejabber\.com|goodfirms\.co|betalist\.com|appsumo\.com)$/,
  },
];

export function sourceKind(domain: string): SourceKind {
  return SOURCE_PATTERNS.find((p) => p.hosts.test(domain))?.kind ?? "editorial";
}

export function anchorKind(link: Pick<ProfileLink, "anchorText" | "isImage">, brand: string[]): AnchorKind {
  const text = link.anchorText.trim().toLowerCase();
  if (link.isImage || !text) return "image";
  if (/^(https?:\/\/|www\.)/.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(text)) return "url";
  if (brand.some((b) => text.includes(b))) return "branded";
  if (GENERIC_ANCHORS.has(text)) return "generic";
  return "keyword";
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function topEntries<T>(map: Map<string, T>, score: (v: T) => number, n: number): [string, T][] {
  return [...map.entries()].sort((a, b) => score(b[1]) - score(a[1])).slice(0, n);
}

export function buildProfile(links: ProfileLink[], ownerDomain: string): LinkProfile {
  const brand = brandTokens(ownerDomain);
  const rel: Record<LinkRel, number> = { follow: 0, nofollow: 0, ugc: 0, sponsored: 0 };
  const anchors: Record<AnchorKind, number> = { branded: 0, keyword: 0, url: 0, generic: 0, image: 0 };
  const sources: Record<SourceKind, number> = { editorial: 0, directory: 0, community: 0, social: 0 };
  const anchorCounts = new Map<string, { count: number; kind: AnchorKind }>();
  const domainCounts = new Map<string, { links: number; authority: number | null }>();
  let authoritySum = 0;
  let authorityCount = 0;

  for (const link of links) {
    rel[link.rel]++;
    const kind = anchorKind(link, brand);
    anchors[kind]++;

    const text = link.anchorText.trim();
    if (text) {
      const key = text.toLowerCase();
      const entry = anchorCounts.get(key) ?? { count: 0, kind };
      entry.count++;
      anchorCounts.set(key, entry);
    }

    const d = domainCounts.get(link.sourceDomain) ?? { links: 0, authority: link.authority };
    d.links++;
    if (link.authority !== null && (d.authority === null || link.authority > d.authority)) d.authority = link.authority;
    domainCounts.set(link.sourceDomain, d);
  }

  for (const [domain, d] of domainCounts) {
    sources[sourceKind(domain)]++;
    if (d.authority !== null) {
      authoritySum += d.authority;
      authorityCount++;
    }
  }

  const profile: LinkProfile = {
    totalLinks: links.length,
    referringDomains: domainCounts.size,
    followShare: pct(rel.follow, links.length),
    avgAuthority: authorityCount ? Math.round(authoritySum / authorityCount) : null,
    rel,
    anchors,
    sources,
    topAnchors: topEntries(anchorCounts, (v) => v.count, 8).map(([text, v]) => ({ text, ...v })),
    topDomains: topEntries(domainCounts, (v) => v.links * 1000 + (v.authority ?? 0), 10).map(([domain, v]) => ({
      domain,
      ...v,
      kind: sourceKind(domain),
    })),
    insights: [],
  };
  profile.insights = describeProfile(profile);
  return profile;
}

export function describeProfile(p: LinkProfile): ProfileInsight[] {
  if (p.totalLinks === 0) return [];
  const out: ProfileInsight[] = [];
  const anchorShare = (k: AnchorKind) => pct(p.anchors[k], p.totalLinks);
  const sourceShare = (k: SourceKind) => pct(p.sources[k], p.referringDomains);

  if (p.followShare >= 75) {
    out.push({
      id: "follow-heavy",
      tone: "strength",
      title: `${p.followShare}% of links pass authority`,
      detail: "Most links are plain follow links, the kind earned in editorial content. These are the ones that move rankings.",
    });
  } else if (p.followShare < 40) {
    out.push({
      id: "nofollow-heavy",
      tone: "neutral",
      title: `Only ${p.followShare}% are follow links`,
      detail: "Most links are nofollow, ugc or sponsored: social posts, comments, forums and paid placements. They send visitors but pass little ranking weight.",
    });
  }

  if (p.rel.sponsored > 0 && pct(p.rel.sponsored, p.totalLinks) >= 10) {
    out.push({
      id: "paid",
      tone: "neutral",
      title: `${pct(p.rel.sponsored, p.totalLinks)}% are marked sponsored`,
      detail: "A visible share of links are paid placements: sponsorships, affiliate listings or advertorials.",
    });
  }

  if (anchorShare("branded") >= 50) {
    out.push({
      id: "branded",
      tone: "strength",
      title: "Links come from brand mentions",
      detail: `${anchorShare("branded")}% of anchors use the brand name. That is how a naturally earned profile looks: press, reviews, partners and people recommending them by name.`,
    });
  }
  if (anchorShare("keyword") >= 30) {
    out.push({
      id: "keyword",
      tone: "risk",
      title: `${anchorShare("keyword")}% keyword anchors`,
      detail: "A high share of descriptive keyword anchors usually means deliberate link building: guest posts, niche edits, outreach. It works, but past about 30% it is a pattern search engines scrutinise.",
    });
  }
  if (anchorShare("url") >= 40) {
    out.push({
      id: "naked-url",
      tone: "neutral",
      title: "Mostly bare-URL anchors",
      detail: "Anchors are mostly the address itself, which is typical of directories, citations and resource lists.",
    });
  }

  if (sourceShare("directory") >= 20) {
    out.push({
      id: "directories",
      tone: "neutral",
      title: `${sourceShare("directory")}% of domains are directories`,
      detail: "Listings and review sites make up a large part of the profile. These are usually open to anyone, so they are the easiest links to match.",
    });
  }
  if (sourceShare("community") >= 15) {
    out.push({
      id: "community",
      tone: "strength",
      title: "Active in communities",
      detail: `${sourceShare("community")}% of linking domains are communities such as Reddit, Hacker News, GitHub and forums. Their links come from being discussed and recommended.`,
    });
  }
  if (sourceShare("social") >= 30) {
    out.push({
      id: "social",
      tone: "neutral",
      title: "Driven by social",
      detail: `${sourceShare("social")}% of linking domains are social networks. Good for reach, but those links are almost always nofollow.`,
    });
  }
  if (sourceShare("editorial") >= 60 && p.referringDomains >= 5) {
    out.push({
      id: "editorial",
      tone: "strength",
      title: "Editorial coverage",
      detail: `${sourceShare("editorial")}% of linking domains are independent sites (blogs, news, publications) rather than profiles or listings.`,
    });
  }

  const top = p.topDomains[0];
  if (top && p.totalLinks >= 5 && pct(top.links, p.totalLinks) >= 30) {
    out.push({
      id: "concentrated",
      tone: "risk",
      title: `${pct(top.links, p.totalLinks)}% from one domain`,
      detail: `${top.domain} provides a large share of all links. The profile is concentrated, so losing that one source would hurt.`,
    });
  }
  if (p.referringDomains > 0 && p.totalLinks / p.referringDomains >= 5) {
    out.push({
      id: "sitewide",
      tone: "neutral",
      title: "Many links per domain",
      detail: `On average ${Math.round(p.totalLinks / p.referringDomains)} links per domain, which points to sitewide links in footers, sidebars or blogrolls.`,
    });
  }

  if (p.avgAuthority !== null) {
    out.push({
      id: "authority",
      tone: p.avgAuthority >= 40 ? "strength" : "neutral",
      title: `Average linking-domain authority ${p.avgAuthority}/100`,
      detail:
        p.avgAuthority >= 40
          ? "Links come from established, well-linked sites."
          : "Links come mostly from smaller or newer sites.",
    });
  }

  return out;
}
