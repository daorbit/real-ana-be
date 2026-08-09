import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { safeFetch } from "../../infra/http-client/safe-fetch.js";
import { validateStructuredData } from "./schema-validate.js";

/**
 * Lightweight audit of a competitor's page.
 *
 * Deliberately thinner than the full audit. No Lighthouse — every PageSpeed
 * call costs quota that belongs to the customer's own sites, and nobody needs
 * a competitor's accessibility score. No link checking either: requesting every
 * link on someone else's page is not a diagnostic, it is traffic they did not
 * ask for.
 *
 * What is left is what a comparison actually needs: the on-page decisions a
 * competitor made that you can see from one fetch. Everything below is derived
 * from that single response — the richer fields cost no extra requests.
 *
 * Previously lived in `modules/analytics/compare.ts`, which was a misfile: it
 * imports from this directory and is only ever called by the SEO routes.
 */

/** A heading in document order, for comparing how two pages are structured. */
export type HeadingNode = {
  /** 1-6. */
  level: number;
  text: string;
};

export type CompareSnapshot = {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  statusCode: number;
  responseTimeMs: number;
  /** HTML transfer size in bytes. */
  pageBytes: number;

  title: string;
  titleLength: number;
  description: string;
  descriptionLength: number;
  canonical: string;

  h1Count: number;
  h2Count: number;
  wordCount: number;
  imageCount: number;
  imagesMissingAlt: number;
  internalLinks: number;
  externalLinks: number;

  hasHttps: boolean;
  hasOpenGraph: boolean;
  hasTwitterCards: boolean;
  hasStructuredData: boolean;
  schemaTypes: string[];
  schemaErrors: number;

  /* --- richer fields, all from the same single fetch ---
   *
   * Optional because snapshots are stored as `Mixed` on the competitor
   * document, so every row written before these shipped is missing them
   * entirely. Anything reading a stored snapshot must cope with their absence
   * rather than assume a fresh fetch. */

  /** The H1/H2 outline, capped — how the page argues its case. */
  headings?: HeadingNode[];
  /** The `robots` meta directive, lowercased. Empty when absent. */
  metaRobots?: string;
  /** True when the canonical points somewhere other than the fetched URL. */
  canonicalMismatch?: boolean;
  /** Distinct `hreflang` values — whether they run a localised site. */
  hreflangs?: string[];
  /** Most frequent meaningful words, for overlap against your own page. */
  keywords?: { word: string; count: number }[];
  /** Whether the page ships a `viewport` meta tag. */
  hasMobileViewport?: boolean;
  /** Rendered text bytes over total HTML bytes, as a percentage. */
  textRatio?: number;

  /** Same 0-100 on-page score used for your own pages, so the two compare. */
  score: number;
};

const TIMEOUT = 15_000;

/** Outline entries kept. Enough to see the shape, not the whole document. */
const MAX_HEADINGS = 40;
const MAX_KEYWORDS = 25;

/**
 * Words carrying no topical signal.
 *
 * Without this the keyword list for every page on the internet is "the", "and",
 * "to" — true, and useless for telling two pages apart.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "from", "are",
  "our", "out", "not", "can", "all", "how", "why", "what", "when", "who",
  "has", "have", "was", "were", "will", "would", "should", "could", "into",
  "more", "most", "other", "than", "then", "them", "they", "their", "there",
  "been", "being", "does", "did", "get", "got", "its", "it's", "about", "also",
  "any", "one", "two", "new", "use", "used", "using", "see", "may", "each",
  "just", "only", "over", "such", "some", "these", "those", "which", "while",
  "here", "make", "makes", "made", "like", "back", "even", "much", "many",
]);

/**
 * Score a snapshot on the on-page signals alone.
 *
 * This is deliberately *not* the same formula as a full audit, which blends in
 * Lighthouse. Comparing a competitor's Lighthouse-free number against your
 * Lighthouse-inclusive one would be meaningless, so both sides of a comparison
 * are scored this way and the UI says so.
 */
export function scoreSnapshot(s: Omit<CompareSnapshot, "score">): number {
  let score = 100;

  if (!s.title) score -= 15;
  else if (s.titleLength < 30 || s.titleLength > 60) score -= 5;

  if (!s.description) score -= 15;
  else if (s.descriptionLength < 70 || s.descriptionLength > 160) score -= 5;

  if (s.h1Count === 0) score -= 12;
  else if (s.h1Count > 1) score -= 4;

  if (!s.canonical) score -= 5;
  if (!s.hasHttps) score -= 15;
  if (!s.hasOpenGraph) score -= 5;
  if (!s.hasTwitterCards) score -= 2;

  if (!s.hasStructuredData) score -= 8;
  else if (s.schemaErrors > 0) score -= 4;

  if (s.wordCount < 300) score -= 10;
  else if (s.wordCount < 150) score -= 15;

  if (s.imageCount > 0 && s.imagesMissingAlt / s.imageCount > 0.5) score -= 5;
  if (s.internalLinks < 3) score -= 3;
  if (s.statusCode >= 400) score -= 40;
  if (s.responseTimeMs > 1500) score -= 5;

  // Kept small: these are newer signals, and a comparison whose ranking shifts
  // wildly the day the fields shipped would read as a bug rather than a fix.
  //
  // Only penalised when the field was actually captured. A snapshot stored
  // before these shipped has them undefined, and "we did not measure it" must
  // not score the same as "they do not have it" — that would silently drop
  // every old competitor by 5 points the day this deployed.
  if (s.hasMobileViewport === false) score -= 5;
  if (/noindex/.test(s.metaRobots ?? "")) score -= 20;

  return Math.max(0, Math.min(100, score));
}

/** The H1-H3 outline in document order. */
function outline($: CheerioAPI): HeadingNode[] {
  return $("h1, h2, h3")
    .toArray()
    .slice(0, MAX_HEADINGS)
    .map((el) => ({
      level: Number(el.tagName.slice(1)) || 2,
      text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 200),
    }))
    .filter((h) => h.text.length > 0);
}

/** The most frequent meaningful words, longest-tail first. */
function keywords(text: string): { word: string; count: number }[] {
  const counts = new Map<string, number>();

  for (const raw of text.toLowerCase().split(/[^a-z0-9'-]+/)) {
    // Three characters is where abbreviations worth counting start ("seo",
    // "api") and where noise mostly stops.
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_KEYWORDS);
}

/**
 * Fetch and analyse one page.
 *
 * Every request goes through `safeFetch`, which is what makes it safe to point
 * this at a hostname the user typed: private ranges, loopback and cloud
 * metadata are all unreachable, and redirects are re-validated per hop.
 */
export async function snapshotPage(rawUrl: string): Promise<CompareSnapshot> {
  const res = await safeFetch(rawUrl, {
    timeoutMs: TIMEOUT,
    maxRedirects: 5,
    headers: { Accept: "text/html,application/xhtml+xml" },
  });

  const $ = cheerio.load(res.body);
  const base = res.finalUrl;
  const host = new URL(base).hostname.replace(/^www\./, "");

  let internalLinks = 0;
  let externalLinks = 0;
  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#")) return;
    if (/^(mailto:|tel:|javascript:|data:|sms:)/i.test(href)) return;
    try {
      const h = new URL(href, base).hostname.replace(/^www\./, "");
      if (h === host || h.endsWith(`.${host}`)) internalLinks++;
      else externalLinks++;
    } catch {
      /* unparseable href counts as neither */
    }
  });

  const rawSchemas = $('script[type="application/ld+json"]')
    .map((_i, el) => $(el).text())
    .get()
    .filter((t) => t.trim().length > 0);
  const schema = validateStructuredData(rawSchemas);

  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content") ?? "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const totalImages = $("img").length;
  const canonical = $('link[rel="canonical"]').attr("href") ?? "";
  const pageBytes = Buffer.byteLength(res.body);

  // Compared as resolved absolute URLs: a relative canonical and an absolute
  // one can name the same page, and flagging that as a mismatch is a false
  // positive the user then has to disprove by hand.
  let canonicalMismatch = false;
  if (canonical) {
    try {
      canonicalMismatch = new URL(canonical, base).href.replace(/\/$/, "") !==
        base.replace(/\/$/, "");
    } catch {
      canonicalMismatch = true;
    }
  }

  const hreflangs = [
    ...new Set(
      $("link[rel='alternate'][hreflang]")
        .map((_i, el) => ($(el).attr("hreflang") ?? "").trim().toLowerCase())
        .get()
        .filter(Boolean)
    ),
  ];

  const partial = {
    url: rawUrl,
    finalUrl: base,
    fetchedAt: new Date().toISOString(),
    statusCode: res.status,
    responseTimeMs: res.elapsedMs,
    pageBytes,

    title,
    titleLength: title.length,
    description,
    descriptionLength: description.length,
    canonical,

    h1Count: $("h1").length,
    h2Count: $("h2").length,
    wordCount: bodyText ? bodyText.split(" ").filter(Boolean).length : 0,
    imageCount: totalImages,
    imagesMissingAlt: totalImages - $("img[alt]").length,
    internalLinks,
    externalLinks,

    hasHttps: base.startsWith("https"),
    hasOpenGraph: $('meta[property^="og:"]').length > 0,
    hasTwitterCards: $('meta[name^="twitter:"]').length > 0,
    hasStructuredData: rawSchemas.length > 0,
    schemaTypes: schema.types,
    schemaErrors: schema.errorCount,

    headings: outline($),
    metaRobots: ($('meta[name="robots"]').attr("content") ?? "").toLowerCase().trim(),
    canonicalMismatch,
    hreflangs,
    keywords: keywords(bodyText),
    hasMobileViewport: $('meta[name="viewport"]').length > 0,
    textRatio: pageBytes > 0
      ? Math.round((Buffer.byteLength(bodyText) / pageBytes) * 100)
      : 0,
  };

  return { ...partial, score: scoreSnapshot(partial) };
}

/**
 * Your own audit, reduced to the shape a competitor snapshot has.
 *
 * A full audit measures far more than a competitor snapshot can (Lighthouse,
 * link checking, real-user vitals), so comparing the two directly would flatter
 * whichever side had more inputs. Narrowing your own report to exactly the
 * fields a competitor fetch produces — and re-scoring it with the same formula
 * — is what makes the two numbers mean the same thing.
 *
 * This ran in the browser before competitors had a page of their own, which
 * left the scoring formula written twice. It belongs here, beside the formula
 * it has to agree with.
 */
export function snapshotFromReport(data: {
  url: string;
  finalUrl: string;
  meta: { title: string; description: string; canonical: string; robots: string };
  content: {
    h1Count: number;
    h2Count: number;
    wordCount: number;
    imgCount: number;
    internalLinks: number;
    externalLinks: number;
    hasSchema: boolean;
    schemaTypes: string[];
    headingStructure: { level: number; count: number; texts: string[] }[];
    keywordDensity: { word: string; count: number }[];
  };
  technical: {
    statusCode: number;
    responseTimeMs: number;
    contentLength: string;
    hasHttps: boolean;
    hasOpenGraph: boolean;
    hasTwitterCards: boolean;
    hasMobileViewport: boolean;
    missingAltImages: number;
  };
  schema?: { errorCount: number };
}): CompareSnapshot {
  // The audit groups heading texts by level; a snapshot outline is flat and in
  // document order. Exact source order is not recoverable from the grouping, so
  // it is rebuilt level by level — enough to compare which topics a page covers,
  // which is all the comparison uses it for.
  const headings: HeadingNode[] = data.content.headingStructure
    .filter((h) => h.level <= 3)
    .flatMap((h) => h.texts.map((text) => ({ level: h.level, text })))
    .slice(0, MAX_HEADINGS);

  const pageBytes = Number(data.technical.contentLength) || 0;

  const partial = {
    url: data.url,
    finalUrl: data.finalUrl,
    fetchedAt: new Date().toISOString(),
    statusCode: data.technical.statusCode,
    responseTimeMs: data.technical.responseTimeMs,
    pageBytes,

    title: data.meta.title,
    titleLength: data.meta.title.length,
    description: data.meta.description,
    descriptionLength: data.meta.description.length,
    canonical: data.meta.canonical,

    h1Count: data.content.h1Count,
    h2Count: data.content.h2Count,
    wordCount: data.content.wordCount,
    imageCount: data.content.imgCount,
    imagesMissingAlt: data.technical.missingAltImages,
    internalLinks: data.content.internalLinks,
    externalLinks: data.content.externalLinks,

    hasHttps: data.technical.hasHttps,
    hasOpenGraph: data.technical.hasOpenGraph,
    hasTwitterCards: data.technical.hasTwitterCards,
    hasStructuredData: data.content.hasSchema,
    schemaTypes: data.content.schemaTypes,
    schemaErrors: data.schema?.errorCount ?? 0,

    headings,
    metaRobots: (data.meta.robots ?? "").toLowerCase().trim(),
    // Not recomputed from the audit: it resolves the canonical against the
    // fetched URL, and the audit already reports a wrong canonical as its own
    // issue. Claiming a mismatch here from less information would double-report
    // it, sometimes disagreeing with the audit that has the better answer.
    canonicalMismatch: false,
    hreflangs: [],
    keywords: data.content.keywordDensity
      .slice(0, MAX_KEYWORDS)
      .map((k) => ({ word: k.word, count: k.count })),
    hasMobileViewport: data.technical.hasMobileViewport,
    textRatio: 0,
  };

  return { ...partial, score: scoreSnapshot(partial) };
}
