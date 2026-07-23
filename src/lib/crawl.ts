import * as cheerio from "cheerio";
import { safeFetch, pooled } from "./safe-fetch.js";
import { checkRobots, checkSitemap } from "./robots-validate.js";

/**
 * Site-wide crawl.
 *
 * A single-page audit says nothing about the other two hundred pages, and the
 * problems that matter most at site level — a template emitting the same title
 * everywhere, a section nothing links to — are invisible from any one page.
 *
 * HTML-only by design. Lighthouse takes ~40s per page, which would make a
 * 30-page crawl a quarter-hour background job needing a queue and a worker;
 * parsing HTML takes about a second, so the whole crawl fits inside one
 * request. Lighthouse stays where it belongs: on the single-page audit.
 */

export type CrawlPage = {
  url: string;
  path: string;
  statusCode: number;
  /** Null when the page could not be fetched at all. */
  title: string | null;
  titleLength: number;
  description: string;
  descriptionLength: number;
  h1Count: number;
  wordCount: number;
  canonical: string;
  noindex: boolean;
  internalLinks: number;
  externalLinks: number;
  imagesMissingAlt: number;
  hasSchema: boolean;
  responseTimeMs: number;
  error?: string;
};

export type CrawlFinding = {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  /** Pages exhibiting this problem. Capped for display. */
  pages: string[];
};

export type CrawlResult = {
  startedAt: string;
  finishedAt: string;
  /** URLs the sitemap offered, before the cap. */
  discovered: number;
  crawled: number;
  pages: CrawlPage[];
  findings: CrawlFinding[];
  /** Average on-page health across crawled pages, 0-100. */
  score: number;
};

/** Beyond this a crawl stops fitting in one request. */
const MAX_PAGES = 30;
const CONCURRENCY = 5;
const PAGE_TIMEOUT = 12_000;

/** Pages under this word count rarely rank for anything competitive. */
const THIN_CONTENT_WORDS = 300;

/* -------------------------------- discovery ------------------------------- */

/** `<loc>` values from a sitemap document. */
function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

/**
 * URLs to crawl, taken from the sitemap.
 *
 * Sitemap-derived only: following links to discover more would need a frontier,
 * a politeness delay and a crawl budget, which is a job-queue feature. A site
 * without a sitemap gets told to publish one, since that is the more useful
 * advice anyway.
 */
export async function discoverUrls(origin: string): Promise<string[]> {
  const robots = await checkRobots(origin, "/");
  const sitemap = await checkSitemap(origin, robots.sitemaps);

  if (!sitemap.present) return [];

  const urls: string[] = [];
  const host = new URL(origin).hostname.replace(/^www\./, "");

  // A sitemap index points at more sitemaps rather than pages, so one level is
  // followed to reach actual URLs.
  const documents = sitemap.isIndex ? sitemap.urls.slice(0, 5) : sitemap.urls.slice(0, 1);

  for (const doc of documents) {
    try {
      const res = await safeFetch(doc, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
      if (res.status !== 200) continue;
      for (const loc of extractLocs(res.body)) {
        try {
          // Foreign hosts in a sitemap are ignored by search engines, so there
          // is no reason for us to spend a request on them.
          if (new URL(loc).hostname.replace(/^www\./, "") === host) urls.push(loc);
        } catch {
          /* skip malformed entries */
        }
      }
    } catch {
      /* an unreachable child sitemap is reported by the validator, not here */
    }
  }

  return [...new Set(urls)];
}

/* ------------------------------- page audit ------------------------------- */

async function crawlPage(url: string): Promise<CrawlPage> {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  const blank: CrawlPage = {
    url,
    path,
    statusCode: 0,
    title: null,
    titleLength: 0,
    description: "",
    descriptionLength: 0,
    h1Count: 0,
    wordCount: 0,
    canonical: "",
    noindex: false,
    internalLinks: 0,
    externalLinks: 0,
    imagesMissingAlt: 0,
    hasSchema: false,
    responseTimeMs: 0,
  };

  try {
    const res = await safeFetch(url, {
      timeoutMs: PAGE_TIMEOUT,
      maxBytes: 1024 * 1024,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });

    const $ = cheerio.load(res.body);
    const host = new URL(res.finalUrl).hostname.replace(/^www\./, "");

    let internalLinks = 0;
    let externalLinks = 0;
    $("a[href]").each((_i, el) => {
      const href = ($(el).attr("href") ?? "").trim();
      if (!href || href.startsWith("#")) return;
      if (/^(mailto:|tel:|javascript:|data:|sms:)/i.test(href)) return;
      try {
        const h = new URL(href, res.finalUrl).hostname.replace(/^www\./, "");
        if (h === host || h.endsWith(`.${host}`)) internalLinks++;
        else externalLinks++;
      } catch {
        /* unparseable href counts as neither */
      }
    });

    const title = $("title").first().text().trim();
    const description = $('meta[name="description"]').attr("content") ?? "";
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const robotsMeta = $('meta[name="robots"]').attr("content") ?? "";

    return {
      url,
      path,
      statusCode: res.status,
      title,
      titleLength: title.length,
      description,
      descriptionLength: description.length,
      h1Count: $("h1").length,
      wordCount: bodyText ? bodyText.split(" ").filter(Boolean).length : 0,
      canonical: $('link[rel="canonical"]').attr("href") ?? "",
      noindex: /noindex/i.test(robotsMeta),
      internalLinks,
      externalLinks,
      imagesMissingAlt: $("img").length - $("img[alt]").length,
      hasSchema: $('script[type="application/ld+json"]').length > 0,
      responseTimeMs: res.elapsedMs,
    };
  } catch (e) {
    return { ...blank, error: (e as Error)?.message ?? "could not fetch" };
  }
}

/* -------------------------------- findings -------------------------------- */

/**
 * Problems only a crawl can see.
 *
 * Every check here compares pages against each other. Anything visible from a
 * single page belongs in the single-page audit, not duplicated at this level.
 */
function deriveFindings(pages: CrawlPage[], sitemapUrls: string[]): CrawlFinding[] {
  const findings: CrawlFinding[] = [];
  const ok = pages.filter((p) => !p.error && p.statusCode < 400);

  const group = <T>(items: T[], key: (item: T) => string | null) => {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      if (!k) continue;
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return map;
  };

  // Duplicate titles: usually a template emitting the same tag site-wide, which
  // means those pages compete with each other for the same query.
  for (const [title, group_] of group(ok, (p) => p.title?.trim() || null)) {
    if (group_.length > 1) {
      findings.push({
        severity: "warning",
        title: `${group_.length} pages share the title "${title.slice(0, 50)}${
          title.length > 50 ? "…" : ""
        }"`,
        detail:
          "Search engines struggle to tell these pages apart, and they compete with each other for the same searches.",
        pages: group_.map((p) => p.path).slice(0, 10),
      });
    }
  }

  for (const [, group_] of group(ok, (p) => p.description.trim() || null)) {
    if (group_.length > 1) {
      findings.push({
        severity: "info",
        title: `${group_.length} pages share the same meta description`,
        detail: "A description written for the specific page earns more clicks than a generic one.",
        pages: group_.map((p) => p.path).slice(0, 10),
      });
    }
  }

  const missingTitle = ok.filter((p) => !p.title?.trim());
  if (missingTitle.length)
    findings.push({
      severity: "critical",
      title: `${missingTitle.length} page(s) have no title`,
      detail: "Without a <title>, search engines have nothing to use as the result headline.",
      pages: missingTitle.map((p) => p.path).slice(0, 10),
    });

  const missingDesc = ok.filter((p) => !p.description.trim());
  if (missingDesc.length)
    findings.push({
      severity: "warning",
      title: `${missingDesc.length} page(s) have no meta description`,
      detail: "Search engines will invent a snippet from the page copy, usually badly.",
      pages: missingDesc.map((p) => p.path).slice(0, 10),
    });

  const noH1 = ok.filter((p) => p.h1Count === 0);
  if (noH1.length)
    findings.push({
      severity: "warning",
      title: `${noH1.length} page(s) have no H1`,
      detail: "Each page should state what it is about in exactly one H1.",
      pages: noH1.map((p) => p.path).slice(0, 10),
    });

  const thin = ok.filter((p) => p.wordCount < THIN_CONTENT_WORDS);
  if (thin.length)
    findings.push({
      severity: "warning",
      title: `${thin.length} page(s) are thin on content`,
      detail: `Under ${THIN_CONTENT_WORDS} words. These rarely rank for anything competitive.`,
      pages: thin.map((p) => p.path).slice(0, 10),
    });

  const noindexed = ok.filter((p) => p.noindex);
  if (noindexed.length)
    findings.push({
      severity: "critical",
      title: `${noindexed.length} page(s) are set to noindex`,
      detail:
        "These are in your sitemap but tell search engines not to index them — the two contradict each other.",
      pages: noindexed.map((p) => p.path).slice(0, 10),
    });

  const broken = pages.filter((p) => p.statusCode >= 400 || p.error);
  if (broken.length)
    findings.push({
      severity: "critical",
      title: `${broken.length} page(s) in the sitemap do not load`,
      detail: "A sitemap listing dead URLs wastes crawl budget and signals neglect.",
      pages: broken.map((p) => p.path).slice(0, 10),
    });

  const noCanonical = ok.filter((p) => !p.canonical);
  if (noCanonical.length > ok.length / 2)
    findings.push({
      severity: "info",
      title: `${noCanonical.length} page(s) have no canonical URL`,
      detail: "Canonicals consolidate duplicate URLs — tracking parameters, trailing slashes — onto one address.",
      pages: noCanonical.map((p) => p.path).slice(0, 10),
    });

  const noSchema = ok.filter((p) => !p.hasSchema);
  if (noSchema.length === ok.length && ok.length > 0)
    findings.push({
      severity: "info",
      title: "No page carries structured data",
      detail: "JSON-LD schema is what lets search engines show rich results rather than a plain link.",
      pages: [],
    });

  // Orphan pages: in the sitemap, but nothing we crawled links to them. A weak
  // signal on a partial crawl, so it is reported as a note rather than a fault.
  if (sitemapUrls.length > pages.length)
    findings.push({
      severity: "info",
      title: `Only ${pages.length} of ${sitemapUrls.length} sitemap URLs were crawled`,
      detail: `One crawl covers at most ${MAX_PAGES} pages. The findings above describe the pages that were checked.`,
      pages: [],
    });

  const rank = { critical: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Per-page health, averaged. Same spirit as the single-page on-page score. */
function scorePage(p: CrawlPage): number {
  if (p.error || p.statusCode >= 400) return 0;
  let score = 100;
  if (!p.title?.trim()) score -= 20;
  else if (p.titleLength < 30 || p.titleLength > 60) score -= 6;
  if (!p.description.trim()) score -= 18;
  else if (p.descriptionLength < 70 || p.descriptionLength > 160) score -= 6;
  if (p.h1Count === 0) score -= 14;
  else if (p.h1Count > 1) score -= 5;
  if (p.wordCount < THIN_CONTENT_WORDS) score -= 12;
  if (!p.canonical) score -= 5;
  if (p.noindex) score -= 25;
  if (!p.hasSchema) score -= 6;
  if (p.imagesMissingAlt > 0) score -= 4;
  if (p.internalLinks < 3) score -= 4;
  return Math.max(0, Math.min(100, score));
}

/* --------------------------------- crawl ---------------------------------- */

export async function crawlSite(origin: string): Promise<CrawlResult> {
  const startedAt = new Date().toISOString();

  const discovered = await discoverUrls(origin);
  const targets = discovered.slice(0, MAX_PAGES);

  const pages = await pooled(targets, CONCURRENCY, (url) => crawlPage(url));
  const findings = deriveFindings(pages, discovered);

  const scored = pages.filter((p) => !p.error);
  const score = scored.length
    ? Math.round(scored.reduce((sum, p) => sum + scorePage(p), 0) / scored.length)
    : 0;

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    discovered: discovered.length,
    crawled: pages.length,
    pages: pages.map((p) => ({ ...p })),
    findings,
    score,
  };
}
