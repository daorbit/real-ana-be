import axios from "axios";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

/**
 * On-page SEO auditing for a single URL.
 *
 * Two sources feed a report. The page itself is fetched once and parsed with
 * cheerio — that gives meta tags, headings, images, schema and the technical
 * signals. Google PageSpeed Insights supplies the Lighthouse scores, which we
 * cannot compute ourselves without running a headless browser.
 *
 * Everything here is deliberately tolerant: a site with no robots.txt, no
 * PageSpeed key, or a slow sitemap should still produce a usable report rather
 * than an error page.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Quantalog-SEO/1.0";

const PAGE_TIMEOUT = 15_000;
const FILE_TIMEOUT = 6_000;
/** PageSpeed runs a real Lighthouse audit server-side; it is genuinely slow. */
const PSI_TIMEOUT = 70_000;

export type MetaTag = { name: string; content: string };

export type SeoMeta = {
  title: string;
  description: string;
  keywords: string;
  author: string;
  robots: string;
  viewport: string;
  charset: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogUrl: string;
  ogType: string;
  ogSiteName: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  twitterCard: string;
  twitterSite: string;
  canonical: string;
  favicon: string;
  allMetaTags: MetaTag[];
};

export type SeoImage = {
  src: string;
  alt: string;
  title: string;
  width: number | null;
  height: number | null;
  loading: string;
  hasAlt: boolean;
};

export type HeadingLevel = { level: number; count: number; texts: string[] };
export type Keyword = { word: string; count: number; density: number };

export type SeoContent = {
  h1Count: number;
  h2Count: number;
  h3Count: number;
  imgCount: number;
  linkCount: number;
  wordCount: number;
  hasSchema: boolean;
  schemaTypes: string[];
  internalLinks: number;
  externalLinks: number;
  headingStructure: HeadingLevel[];
  keywordDensity: Keyword[];
  readabilityScore: number;
  contentQuality: number;
  images: SeoImage[];
};

export type SeoTechnical = {
  statusCode: number;
  contentType: string;
  contentLength: string;
  server: string;
  hasHttps: boolean;
  hasMobileViewport: boolean;
  hasFavicon: boolean;
  hasOpenGraph: boolean;
  hasTwitterCards: boolean;
  hasStructuredData: boolean;
  totalImages: number;
  imageAltCount: number;
  missingAltImages: number;
  responseTimeMs: number;
};

export type SeoScores = {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
};

export type SeoMetrics = {
  firstContentfulPaint: number | null;
  speedIndex: number | null;
  largestContentfulPaint: number | null;
  interactive: number | null;
  totalBlockingTime: number | null;
  cumulativeLayoutShift: number | null;
};

export type SeoStrategyResult = {
  strategy: "mobile" | "desktop";
  scores: SeoScores;
  metrics: SeoMetrics;
};

export type SeoSuggestion = {
  id: string;
  title: string;
  category: string;
  score: number;
  displayValue: string | null;
  description: string;
  advice: string;
  resources: string[];
};

export type SeoPerformance = {
  available: boolean;
  note?: string;
  scores: SeoScores;
  desktop: SeoStrategyResult | null;
  mobile: SeoStrategyResult | null;
  suggestions: SeoSuggestion[];
};

export type SeoSiteFiles = {
  robotsTxt: { present: boolean; url: string };
  sitemap: { present: boolean; urls: string[] };
};

export type SeoIssue = {
  severity: "critical" | "warning" | "info";
  area: "meta" | "content" | "technical" | "files";
  title: string;
  detail: string;
};

export type SeoReportData = {
  url: string;
  finalUrl: string;
  meta: SeoMeta;
  content: SeoContent;
  technical: SeoTechnical;
  performance: SeoPerformance;
  siteFiles: SeoSiteFiles;
  issues: SeoIssue[];
  score: number;
};

/* ------------------------------ url handling ------------------------------ */

/** Adds a scheme when missing and rejects anything that isn't plain http(s). */
export function normalizeUrl(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** True when `url` is on `domain` or one of its subdomains. */
export function urlMatchesDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const base = String(domain)
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "")
      .toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  } catch {
    return false;
  }
}

/* ------------------------------- extraction ------------------------------- */

function extractMeta($: CheerioAPI): SeoMeta {
  const attr = (sel: string, key = "content") => $(sel).attr(key) ?? "";

  const allMetaTags: MetaTag[] = [];
  $("meta").each((_i, el) => {
    const tag = $(el);
    const name = tag.attr("name") ?? tag.attr("property") ?? tag.attr("http-equiv");
    const content = tag.attr("content");
    if (name && content) allMetaTags.push({ name, content });
  });

  return {
    title: $("title").first().text().trim(),
    description: attr('meta[name="description"]'),
    keywords: attr('meta[name="keywords"]'),
    author: attr('meta[name="author"]'),
    robots: attr('meta[name="robots"]'),
    viewport: attr('meta[name="viewport"]'),
    charset: $("meta[charset]").attr("charset") ?? "",
    ogTitle: attr('meta[property="og:title"]'),
    ogDescription: attr('meta[property="og:description"]'),
    ogImage: attr('meta[property="og:image"]'),
    ogUrl: attr('meta[property="og:url"]'),
    ogType: attr('meta[property="og:type"]'),
    ogSiteName: attr('meta[property="og:site_name"]'),
    twitterTitle: attr('meta[name="twitter:title"]'),
    twitterDescription: attr('meta[name="twitter:description"]'),
    twitterImage: attr('meta[name="twitter:image"]'),
    twitterCard: attr('meta[name="twitter:card"]'),
    twitterSite: attr('meta[name="twitter:site"]'),
    canonical: attr('link[rel="canonical"]', "href"),
    favicon: attr('link[rel="icon"], link[rel="shortcut icon"]', "href"),
    allMetaTags,
  };
}

function extractSchemaTypes($: CheerioAPI): string[] {
  const types: string[] = [];
  const push = (t: unknown) => {
    if (typeof t === "string") types.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.push(x));
  };

  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      // JSON-LD legitimately appears as a single node, an array of nodes, or a
      // @graph wrapper. All three are common in the wild.
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["@graph"])
        ? parsed["@graph"]
        : [parsed];
      nodes.forEach((n: Record<string, unknown>) => push(n?.["@type"]));
    } catch {
      /* malformed JSON-LD is the site's problem, not a reason to fail */
    }
  });

  return [...new Set(types)];
}

function extractImages($: CheerioAPI, baseUrl: string): SeoImage[] {
  const images: SeoImage[] = [];
  $("img").each((_i, el) => {
    const img = $(el);
    const src = img.attr("src");
    if (!src) return;

    let absolute = src;
    try {
      absolute = new URL(src, baseUrl).href;
    } catch {
      /* keep the raw value if it will not resolve */
    }

    const alt = img.attr("alt") ?? "";
    const w = Number(img.attr("width"));
    const h = Number(img.attr("height"));

    images.push({
      src: absolute,
      alt,
      title: img.attr("title") ?? "",
      width: Number.isFinite(w) && w > 0 ? w : null,
      height: Number.isFinite(h) && h > 0 ? h : null,
      loading: img.attr("loading") ?? "",
      hasAlt: alt.trim().length > 0,
    });
  });
  // A gallery page can carry hundreds of images; the report only needs enough
  // to act on, and the rest are counted separately anyway.
  return images.slice(0, 100);
}

function countLinks($: CheerioAPI, baseUrl: string) {
  let internal = 0;
  let external = 0;
  const host = new URL(baseUrl).hostname.replace(/^www\./, "");

  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#")) return;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;

    if (/^https?:\/\//i.test(href)) {
      try {
        const h = new URL(href).hostname.replace(/^www\./, "");
        if (h === host || h.endsWith(`.${host}`)) internal++;
        else external++;
      } catch {
        /* unparseable href counts as neither */
      }
    } else {
      internal++;
    }
  });

  return { internal, external };
}

function headingStructure($: CheerioAPI): HeadingLevel[] {
  const out: HeadingLevel[] = [];
  for (let level = 1; level <= 6; level++) {
    const nodes = $(`h${level}`);
    if (!nodes.length) continue;
    out.push({
      level,
      count: nodes.length,
      texts: nodes
        .map((_i, el) => $(el).text().trim().replace(/\s+/g, " "))
        .get()
        .filter(Boolean)
        .slice(0, 20),
    });
  }
  return out;
}

/**
 * Words a density report should never be topped by. Not exhaustive — the point
 * is to stop "the" and "with" from crowding out the terms a page actually
 * ranks for.
 */
const STOP_WORDS = new Set([
  "this", "that", "with", "from", "your", "have", "will", "they", "them", "there",
  "their", "what", "when", "which", "then", "than", "been", "were", "into", "more",
  "most", "some", "such", "only", "also", "just", "like", "over", "very", "here",
  "about", "would", "could", "should", "these", "those", "other", "after", "before",
  "https", "http", "www", "com",
]);

function keywordDensity(text: string): Keyword[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  if (!words.length) return [];

  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word, count]) => ({
      word,
      count,
      density: Number(((count / words.length) * 100).toFixed(2)),
    }));
}

function countSyllables(word: string): number {
  const w = word.toLowerCase();
  if (w.length <= 3) return 1;
  let count = 0;
  let prevVowel = false;
  for (const ch of w) {
    const isVowel = "aeiouy".includes(ch);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  if (w.endsWith("e")) count--;
  return Math.max(1, count);
}

/** Flesch Reading Ease, clamped to 0-100. Higher is easier to read. */
function readability(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter(Boolean);
  if (!sentences.length || !words.length) return 0;

  // Syllable counting over an entire page body is the expensive part, and a
  // sample is more than enough for a reading-ease estimate.
  const sample = words.slice(0, 2000);
  const avgWords = words.length / sentences.length;
  const avgSyllables =
    sample.reduce((sum, w) => sum + countSyllables(w), 0) / sample.length;

  const score = 206.835 - 1.015 * avgWords - 84.6 * avgSyllables;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function contentQuality($: CheerioAPI, wordCount: number): number {
  let score = 0;
  if (wordCount > 600) score += 30;
  else if (wordCount > 300) score += 22;
  else if (wordCount > 150) score += 12;

  if ($("h1").length === 1) score += 15;
  if ($("h2, h3").length > 1) score += 15;

  const total = $("img").length;
  const withAlt = $("img[alt]").length;
  if (total === 0 || withAlt / total > 0.8) score += 20;
  else if (withAlt / total > 0.5) score += 10;

  if ($("a[href]").length > 3) score += 10;
  if ($('script[type="application/ld+json"]').length) score += 10;

  return Math.min(100, score);
}

/* ------------------------------- page fetch ------------------------------- */

async function fetchPage(url: string) {
  const started = Date.now();
  const res = await axios.get<string>(url, {
    timeout: PAGE_TIMEOUT,
    maxRedirects: 5,
    responseType: "text",
    // A 4xx page still has SEO signals worth reporting on, and the status code
    // is itself a finding. Only network-level failures should throw.
    validateStatus: (s) => s < 500,
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
  });
  return { res, responseTimeMs: Date.now() - started };
}

/* ---------------------------- pagespeed insights --------------------------- */

/**
 * Plain-language advice for the Lighthouse audits people actually hit. Falls
 * back to Lighthouse's own description, which is accurate but written for
 * developers who already know what the audit means.
 */
const ADVICE: Record<string, string> = {
  "uses-webp-images":
    "Serve images as WebP or AVIF. They are typically 25-35% smaller than JPEG at the same quality.",
  "modern-image-formats":
    "Serve images as WebP or AVIF instead of PNG/JPEG to cut download size.",
  "uses-text-compression":
    "Enable Brotli or gzip compression on your server for HTML, CSS and JavaScript.",
  "render-blocking-resources":
    "Defer non-critical CSS and JavaScript, or inline the styles needed for the first screen.",
  "unused-css-rules":
    "Split your CSS so each page only loads the rules it uses.",
  "unused-javascript":
    "Remove dead JavaScript and lazy-load bundles that are only needed after interaction.",
  "server-response-time":
    "Reduce time to first byte with server-side caching, a CDN, or faster database queries.",
  "uses-responsive-images":
    "Ship correctly sized images using srcset rather than scaling large files in the browser.",
  "uses-rel-preload":
    "Preload critical assets such as fonts and the hero image so they start downloading sooner.",
  "uses-long-cache-ttl":
    "Set long Cache-Control lifetimes on fingerprinted static assets.",
  "meta-description":
    "Add a unique meta description of roughly 120-160 characters. It is what searchers read in results.",
  "document-title": "Give the page a descriptive <title>.",
  viewport:
    "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> for mobile rendering.",
  "is-crawlable": "Check robots.txt and robots meta tags are not blocking search engines.",
  "image-alt": "Give every meaningful image an alt attribute describing its content.",
  "link-text": "Replace generic link text such as \"click here\" with descriptive wording.",
  "color-contrast": "Increase text/background contrast to at least 4.5:1 for body copy.",
  "font-size": "Use a base font size of at least 16px so mobile users are not pinching to read.",
  "tap-targets": "Make tap targets at least 48x48px with spacing between them.",
  hreflang: "Fix hreflang annotations so the right language version is indexed per region.",
  canonical: "Point rel=canonical at the preferred version of this page.",
};

type PsiAudit = {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  details?: {
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    items?: Array<{ url?: string; wastedBytes?: number; wastedMs?: number }>;
  };
};

const emptyScores = (): SeoScores => ({
  performance: null,
  accessibility: null,
  bestPractices: null,
  seo: null,
});

function buildSuggestion(id: string, audit: PsiAudit, category: string): SeoSuggestion {
  const base = ADVICE[id] ?? audit.description ?? audit.title ?? "";
  const savings: string[] = [];
  if (audit.details?.overallSavingsMs)
    savings.push(`Saves about ${Math.round(audit.details.overallSavingsMs)} ms.`);
  if (audit.details?.overallSavingsBytes)
    savings.push(`Cuts about ${Math.round(audit.details.overallSavingsBytes / 1024)} KB.`);

  const resources = (audit.details?.items ?? [])
    .map((i) => i.url)
    .filter((u): u is string => Boolean(u))
    .slice(0, 5);

  return {
    id,
    title: audit.title ?? id,
    category,
    score: Math.round((audit.score ?? 0) * 100),
    displayValue: audit.displayValue ?? null,
    // Lighthouse descriptions carry markdown link syntax; strip it so the UI
    // can render plain text without a markdown dependency.
    description: (audit.description ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
    advice: [base.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), ...savings].join(" ").trim(),
    resources,
  };
}

async function runPageSpeed(url: string): Promise<SeoPerformance> {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  if (!apiKey) {
    return {
      available: false,
      note: "Lighthouse scores need GOOGLE_PAGESPEED_API_KEY to be configured on the server.",
      scores: emptyScores(),
      desktop: null,
      mobile: null,
      suggestions: [],
    };
  }

  const strategies = ["mobile", "desktop"] as const;
  const categories = ["performance", "accessibility", "best-practices", "seo"];

  const calls = strategies.map((strategy) => {
    const qs = new URLSearchParams({ url, strategy, key: apiKey });
    for (const c of categories) qs.append("category", c);
    return axios.get(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs.toString()}`,
      { timeout: PSI_TIMEOUT }
    );
  });

  // One strategy failing (a timeout on mobile is common for heavy sites) should
  // not throw away the other.
  const settled = await Promise.allSettled(calls);

  const results: SeoStrategyResult[] = [];
  const suggestions = new Map<string, SeoSuggestion>();

  settled.forEach((outcome, i) => {
    if (outcome.status !== "fulfilled") {
      console.error(`PageSpeed ${strategies[i]} failed:`, (outcome.reason as Error)?.message);
      return;
    }

    const lighthouse = outcome.value.data?.lighthouseResult ?? {};
    const audits: Record<string, PsiAudit> = lighthouse.audits ?? {};
    const cats: Record<string, { score?: number; auditRefs?: Array<{ id: string }> }> =
      lighthouse.categories ?? {};

    const pct = (c?: { score?: number }) =>
      c?.score != null ? Math.round(c.score * 100) : null;
    const metric = (key: string) => {
      const v = audits[key]?.numericValue;
      return v != null ? Math.round(v) : null;
    };

    results.push({
      strategy: strategies[i],
      scores: {
        performance: pct(cats.performance),
        accessibility: pct(cats.accessibility),
        bestPractices: pct(cats["best-practices"]),
        seo: pct(cats.seo),
      },
      metrics: {
        firstContentfulPaint: metric("first-contentful-paint"),
        speedIndex: metric("speed-index"),
        largestContentfulPaint: metric("largest-contentful-paint"),
        interactive: metric("interactive"),
        totalBlockingTime: metric("total-blocking-time"),
        cumulativeLayoutShift:
          audits["cumulative-layout-shift"]?.numericValue != null
            ? Number(audits["cumulative-layout-shift"].numericValue!.toFixed(3))
            : null,
      },
    });

    // Map each audit back to the category that references it, so the UI can
    // group findings the same way the Lighthouse report does.
    const categoryOf = new Map<string, string>();
    for (const [name, cat] of Object.entries(cats))
      for (const ref of cat.auditRefs ?? []) categoryOf.set(ref.id, name);

    for (const [id, audit] of Object.entries(audits)) {
      // `notApplicable` and `informative` audits have no score to fail.
      if (audit.score == null || audit.score >= 0.9) continue;
      if (!suggestions.has(id))
        suggestions.set(id, buildSuggestion(id, audit, categoryOf.get(id) ?? "general"));
    }
  });

  if (!results.length) {
    return {
      available: false,
      note: "Google PageSpeed did not return a result for this URL. It may be unreachable from Google's crawler, or the audit timed out.",
      scores: emptyScores(),
      desktop: null,
      mobile: null,
      suggestions: [],
    };
  }

  const desktop = results.find((r) => r.strategy === "desktop") ?? null;
  const mobile = results.find((r) => r.strategy === "mobile") ?? null;

  // Headline scores follow mobile, which is what Google indexes with.
  const primary = mobile ?? desktop;

  return {
    available: true,
    scores: primary ? primary.scores : emptyScores(),
    desktop,
    mobile,
    suggestions: [...suggestions.values()].sort((a, b) => a.score - b.score).slice(0, 40),
  };
}

/* -------------------------------- site files ------------------------------- */

async function checkSiteFiles(url: string): Promise<SeoSiteFiles> {
  const origin = new URL(url).origin;
  const robotsUrl = `${origin}/robots.txt`;
  const sitemapUrl = `${origin}/sitemap.xml`;

  const out: SeoSiteFiles = {
    robotsTxt: { present: false, url: robotsUrl },
    sitemap: { present: false, urls: [] },
  };

  try {
    const res = await axios.get<string>(robotsUrl, {
      timeout: FILE_TIMEOUT,
      responseType: "text",
      headers: { "User-Agent": UA },
    });
    // Plenty of sites answer 200 with an HTML 404 page. A real robots.txt is
    // served as text and does not open with a tag.
    const body = typeof res.data === "string" ? res.data : "";
    out.robotsTxt.present = res.status === 200 && !body.trimStart().startsWith("<");

    if (out.robotsTxt.present) {
      const found = body.match(/^\s*sitemap:\s*(\S+)/gim) ?? [];
      out.sitemap.urls = found
        .map((line) => line.replace(/^\s*sitemap:\s*/i, "").trim())
        .slice(0, 10);
      out.sitemap.present = out.sitemap.urls.length > 0;
    }
  } catch {
    /* absent robots.txt is a finding, not an error */
  }

  if (!out.sitemap.present) {
    try {
      const res = await axios.get<string>(sitemapUrl, {
        timeout: FILE_TIMEOUT,
        responseType: "text",
        headers: { "User-Agent": UA },
      });
      const body = typeof res.data === "string" ? res.data : "";
      if (res.status === 200 && body.includes("<urlset") === false && body.includes("<sitemapindex") === false) {
        // 200 but not XML — almost certainly a soft 404.
      } else if (res.status === 200) {
        out.sitemap.present = true;
        out.sitemap.urls = [sitemapUrl];
      }
    } catch {
      /* no sitemap at the conventional path */
    }
  }

  return out;
}

/* --------------------------------- issues --------------------------------- */

/**
 * The findings a site owner can act on directly, derived from the page itself
 * rather than from Lighthouse. Lighthouse covers performance; this covers the
 * markup decisions it does not grade.
 */
function deriveIssues(
  meta: SeoMeta,
  content: SeoContent,
  technical: SeoTechnical,
  files: SeoSiteFiles
): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const add = (
    severity: SeoIssue["severity"],
    area: SeoIssue["area"],
    title: string,
    detail: string
  ) => issues.push({ severity, area, title, detail });

  const titleLen = meta.title.length;
  if (!titleLen) add("critical", "meta", "Missing page title", "The page has no <title>. Search engines have nothing to show as the result headline.");
  else if (titleLen < 30) add("warning", "meta", "Title is short", `The title is ${titleLen} characters. Aim for 30-60 so it reads as a full phrase in results.`);
  else if (titleLen > 60) add("warning", "meta", "Title is long", `The title is ${titleLen} characters and will be truncated in search results. Aim for 30-60.`);

  const descLen = meta.description.length;
  if (!descLen) add("critical", "meta", "Missing meta description", "Without a description, search engines invent one from page copy — usually badly.");
  else if (descLen < 70) add("warning", "meta", "Description is short", `The description is ${descLen} characters. Aim for 120-160.`);
  else if (descLen > 160) add("warning", "meta", "Description is long", `The description is ${descLen} characters and will be cut off. Aim for 120-160.`);

  if (!meta.canonical) add("warning", "meta", "No canonical URL", "Add rel=canonical so duplicate URLs (tracking parameters, trailing slashes) consolidate onto one address.");
  if (!technical.hasOpenGraph) add("warning", "meta", "No Open Graph tags", "Links shared to social platforms will render without a title, image or description.");
  if (!technical.hasTwitterCards) add("info", "meta", "No Twitter Card tags", "Add twitter:card and friends for a richer preview on X.");
  if (/noindex/i.test(meta.robots)) add("critical", "meta", "Page is set to noindex", "The robots meta tag blocks this page from search results entirely.");

  if (content.h1Count === 0) add("critical", "content", "No H1 heading", "Every page should have exactly one H1 stating what the page is about.");
  else if (content.h1Count > 1) add("warning", "content", "Multiple H1 headings", `Found ${content.h1Count} H1 elements. Keep one and demote the rest to H2.`);

  if (content.wordCount < 300) add("warning", "content", "Thin content", `Only ${content.wordCount} words on the page. Pages under 300 words rarely rank for competitive terms.`);
  if (technical.missingAltImages > 0) add("warning", "content", "Images missing alt text", `${technical.missingAltImages} of ${technical.totalImages} images have no alt attribute.`);
  if (!content.hasSchema) add("info", "content", "No structured data", "Add JSON-LD schema so search engines can show rich results.");
  if (content.internalLinks < 3) add("info", "content", "Few internal links", "Internal links spread authority and help crawlers discover the rest of the site.");

  if (!technical.hasHttps) add("critical", "technical", "Not served over HTTPS", "HTTPS is a ranking signal and browsers flag plain HTTP pages as insecure.");
  if (!technical.hasMobileViewport) add("critical", "technical", "No mobile viewport", "Without a viewport meta tag the page renders at desktop width on phones.");
  if (!technical.hasFavicon) add("info", "technical", "No favicon", "Add a favicon — it appears next to your result on mobile search.");
  if (technical.statusCode >= 400) add("critical", "technical", `Page returned ${technical.statusCode}`, "The URL does not serve a successful response, so it will not be indexed.");
  if (technical.responseTimeMs > 1000) add("warning", "technical", "Slow server response", `The server took ${technical.responseTimeMs} ms to respond. Under 600 ms is a reasonable target.`);

  if (!files.robotsTxt.present) add("warning", "files", "No robots.txt", "Add a robots.txt so crawlers get explicit rules and a sitemap pointer.");
  if (!files.sitemap.present) add("warning", "files", "No sitemap found", "Publish a sitemap.xml and reference it from robots.txt so every page is discoverable.");

  const rank = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * A single headline number, so a report can be compared against last week's at
 * a glance. Lighthouse scores carry it when available; otherwise it falls back
 * to the on-page issues alone, which is a weaker but still honest signal.
 */
function overallScore(perf: SeoPerformance, issues: SeoIssue[]): number {
  const penalty = issues.reduce(
    (sum, i) => sum + (i.severity === "critical" ? 12 : i.severity === "warning" ? 5 : 1),
    0
  );
  const onPage = Math.max(0, 100 - penalty);

  const lh = [perf.scores.seo, perf.scores.performance, perf.scores.accessibility].filter(
    (n): n is number => n != null
  );
  if (!lh.length) return onPage;

  const lhAvg = lh.reduce((a, b) => a + b, 0) / lh.length;
  return Math.round(onPage * 0.5 + lhAvg * 0.5);
}

/* --------------------------------- analyze -------------------------------- */

export async function analyzeUrl(rawUrl: string): Promise<SeoReportData> {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error("invalid URL");

  const { res, responseTimeMs } = await fetchPage(url);
  const html = typeof res.data === "string" ? res.data : String(res.data ?? "");
  const $ = cheerio.load(html);

  // Redirects are followed, so anchor relative URLs and file lookups to where
  // we actually landed rather than where we started.
  const finalUrl = (res.request?.res?.responseUrl as string) ?? url;

  const meta = extractMeta($);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").filter(Boolean).length : 0;
  const links = countLinks($, finalUrl);
  const images = extractImages($, finalUrl);
  const totalImages = $("img").length;
  const imageAltCount = $("img[alt]").length;

  const content: SeoContent = {
    h1Count: $("h1").length,
    h2Count: $("h2").length,
    h3Count: $("h3").length,
    imgCount: totalImages,
    linkCount: $("a[href]").length,
    wordCount,
    hasSchema: $('script[type="application/ld+json"]').length > 0,
    schemaTypes: extractSchemaTypes($),
    internalLinks: links.internal,
    externalLinks: links.external,
    headingStructure: headingStructure($),
    keywordDensity: keywordDensity(bodyText),
    readabilityScore: readability(bodyText),
    contentQuality: contentQuality($, wordCount),
    images,
  };

  const technical: SeoTechnical = {
    statusCode: res.status,
    contentType: String(res.headers["content-type"] ?? ""),
    contentLength: String(res.headers["content-length"] ?? html.length),
    server: String(res.headers["server"] ?? ""),
    hasHttps: finalUrl.startsWith("https"),
    hasMobileViewport: $('meta[name="viewport"]').length > 0,
    hasFavicon: $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').length > 0,
    hasOpenGraph: $('meta[property^="og:"]').length > 0,
    hasTwitterCards: $('meta[name^="twitter:"]').length > 0,
    hasStructuredData: $('script[type="application/ld+json"]').length > 0,
    totalImages,
    imageAltCount,
    missingAltImages: totalImages - imageAltCount,
    responseTimeMs,
  };

  // Independent of each other, and PageSpeed is the slow one — no reason to
  // wait on robots.txt first.
  const [performance, siteFiles] = await Promise.all([
    runPageSpeed(finalUrl),
    checkSiteFiles(finalUrl),
  ]);

  const issues = deriveIssues(meta, content, technical, siteFiles);

  return {
    url,
    finalUrl,
    meta,
    content,
    technical,
    performance,
    siteFiles,
    issues,
    score: overallScore(performance, issues),
  };
}
