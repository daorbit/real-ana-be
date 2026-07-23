import * as cheerio from "cheerio";
import { safeFetch } from "./safe-fetch.js";
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
 * competitor made that you can see from one fetch.
 */

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

  /** Same 0-100 on-page score used for your own pages, so the two compare. */
  score: number;
};

const TIMEOUT = 15_000;

/**
 * Score a snapshot on the on-page signals alone.
 *
 * This is deliberately *not* the same formula as a full audit, which blends in
 * Lighthouse. Comparing a competitor's Lighthouse-free number against your
 * Lighthouse-inclusive one would be meaningless, so both sides of a comparison
 * are scored this way and the UI says so.
 */
function scoreSnapshot(s: Omit<CompareSnapshot, "score">): number {
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

  return Math.max(0, Math.min(100, score));
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

  const partial = {
    url: rawUrl,
    finalUrl: base,
    fetchedAt: new Date().toISOString(),
    statusCode: res.status,
    responseTimeMs: res.elapsedMs,
    pageBytes: Buffer.byteLength(res.body),

    title,
    titleLength: title.length,
    description,
    descriptionLength: description.length,
    canonical: $('link[rel="canonical"]').attr("href") ?? "",

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
  };

  return { ...partial, score: scoreSnapshot(partial) };
}
