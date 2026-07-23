import { safeFetch } from "./safe-fetch.js";

/**
 * robots.txt and sitemap.xml validation.
 *
 * The audit previously checked only that these files *existed*, which meant a
 * robots.txt containing `Disallow: /` — the rule that removes an entire site
 * from search — scored as a green tick. That was not a missing feature so much
 * as a wrong answer, and it is the single most damaging misconfiguration in
 * this whole tool's remit.
 */

export type FileFinding = {
  severity: "critical" | "warning" | "info";
  message: string;
  /** 1-indexed line in robots.txt, where the finding came from one. */
  line?: number;
};

export type RobotsGroup = {
  userAgents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
};

export type RobotsReport = {
  present: boolean;
  url: string;
  /** Raw text, capped — shown in the UI so the user can see what we read. */
  content: string;
  groups: RobotsGroup[];
  sitemaps: string[];
  /** True when `User-agent: *` disallows everything. */
  blocksEverything: boolean;
  /** True when the audited URL is itself blocked for a generic crawler. */
  blocksAuditedUrl: boolean;
  findings: FileFinding[];
};

export type SitemapReport = {
  present: boolean;
  urls: string[];
  /** Total `<loc>` entries found, across an index if there was one. */
  urlCount: number;
  /** True when the document was a `<sitemapindex>` rather than a `<urlset>`. */
  isIndex: boolean;
  bytes: number;
  findings: FileFinding[];
};

/** Search engines ignore a sitemap past either of these. */
const MAX_SITEMAP_URLS = 50_000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

const FILE_TIMEOUT = 8_000;

/* -------------------------------- robots.txt ------------------------------- */

/**
 * Parse robots.txt into its groups.
 *
 * The format is line-based and grouped: consecutive `User-agent` lines share
 * the rules that follow them, and a rule line before any user-agent belongs to
 * no group at all. Getting that grouping right is the difference between
 * reading a rule as site-wide and reading it as applying to one bot.
 */
export function parseRobots(text: string): {
  groups: RobotsGroup[];
  sitemaps: string[];
  findings: FileFinding[];
} {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const findings: FileFinding[] = [];

  let current: RobotsGroup | null = null;
  // Consecutive user-agent lines accumulate into one group rather than each
  // starting a new one.
  let expectingAgents = false;

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) return;

    const sep = line.indexOf(":");
    if (sep === -1) {
      findings.push({
        severity: "warning",
        line: i + 1,
        message: `Line ${i + 1} is not a "directive: value" pair and will be ignored: "${line.slice(0, 60)}"`,
      });
      return;
    }

    const directive = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    switch (directive) {
      case "user-agent": {
        if (!current || !expectingAgents) {
          current = { userAgents: [], allow: [], disallow: [] };
          groups.push(current);
        }
        current.userAgents.push(value.toLowerCase());
        expectingAgents = true;
        break;
      }
      case "allow":
      case "disallow": {
        if (!current) {
          findings.push({
            severity: "warning",
            line: i + 1,
            message: `Line ${i + 1}: "${directive}" appears before any User-agent, so no crawler will apply it.`,
          });
          return;
        }
        expectingAgents = false;
        if (directive === "allow") current.allow.push(value);
        else current.disallow.push(value);
        break;
      }
      case "sitemap": {
        expectingAgents = false;
        sitemaps.push(value);
        if (!/^https?:\/\//i.test(value)) {
          findings.push({
            severity: "warning",
            line: i + 1,
            message: `Sitemap "${value}" must be an absolute URL including the scheme and host.`,
          });
        }
        break;
      }
      case "crawl-delay": {
        expectingAgents = false;
        if (current) {
          const n = Number(value);
          if (Number.isFinite(n)) {
            current.crawlDelay = n;
            if (n > 10) {
              findings.push({
                severity: "warning",
                line: i + 1,
                message: `Crawl-delay of ${n}s is high and will slow how fast your site gets indexed.`,
              });
            }
          }
        }
        break;
      }
      case "host":
      case "clean-param":
      case "noindex":
        expectingAgents = false;
        break;
      default:
        expectingAgents = false;
        findings.push({
          severity: "info",
          line: i + 1,
          message: `Line ${i + 1}: "${directive}" is not a standard robots.txt directive.`,
        });
    }
  });

  return { groups, sitemaps, findings };
}

/**
 * Does a robots.txt path pattern match this URL path?
 *
 * Supports the two wildcards crawlers honour: `*` for any run of characters and
 * `$` to anchor the end.
 */
function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false;

  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether a generic crawler may fetch `path`.
 *
 * Follows the real precedence rule: the longest matching pattern wins, and
 * `Allow` beats `Disallow` on an equal-length tie. A naive "any disallow means
 * blocked" check would report `Disallow: /` plus `Allow: /blog/` as blocking
 * the blog, which is wrong.
 */
export function isPathBlocked(groups: RobotsGroup[], path: string): boolean {
  const group =
    groups.find((g) => g.userAgents.includes("*")) ??
    groups.find((g) => g.userAgents.some((a) => a.includes("googlebot")));
  if (!group) return false;

  let longestDisallow = -1;
  let longestAllow = -1;

  for (const rule of group.disallow) {
    if (pathMatches(rule, path)) longestDisallow = Math.max(longestDisallow, rule.length);
  }
  for (const rule of group.allow) {
    if (pathMatches(rule, path)) longestAllow = Math.max(longestAllow, rule.length);
  }

  if (longestDisallow === -1) return false;
  return longestDisallow > longestAllow;
}

export async function checkRobots(origin: string, auditedPath: string): Promise<RobotsReport> {
  const url = `${origin}/robots.txt`;
  const report: RobotsReport = {
    present: false,
    url,
    content: "",
    groups: [],
    sitemaps: [],
    blocksEverything: false,
    blocksAuditedUrl: false,
    findings: [],
  };

  let text = "";
  try {
    const res = await safeFetch(url, { timeoutMs: FILE_TIMEOUT, maxBytes: 512 * 1024 });
    // Many sites answer 200 with an HTML 404 page. A real robots.txt is plain
    // text and never opens with a tag.
    const looksLikeHtml = res.body.trimStart().startsWith("<");
    report.present = res.status === 200 && !looksLikeHtml;

    if (res.status === 200 && looksLikeHtml) {
      report.findings.push({
        severity: "warning",
        message: "The server returned HTML for /robots.txt, which means the file does not really exist.",
      });
    }
    text = report.present ? res.body : "";
  } catch {
    /* unreachable robots.txt is a finding below, not an exception */
  }

  if (!report.present) {
    report.findings.push({
      severity: "warning",
      message:
        "No robots.txt. Crawlers will index everything they find, and you have nowhere to point them at your sitemap.",
    });
    return report;
  }

  report.content = text.slice(0, 20_000);

  const { groups, sitemaps, findings } = parseRobots(text);
  report.groups = groups;
  report.sitemaps = sitemaps;
  report.findings.push(...findings);

  // The catastrophic case: a staging rule that reached production.
  const wildcard = groups.find((g) => g.userAgents.includes("*"));
  if (wildcard?.disallow.includes("/")) {
    const rescued = wildcard.allow.length > 0;
    report.blocksEverything = !rescued;
    report.findings.push({
      severity: "critical",
      message: rescued
        ? "Disallow: / blocks the whole site for all crawlers. Some Allow rules carve exceptions out, but everything else is hidden from search."
        : "Disallow: / blocks the ENTIRE site from every search engine. If this reached production by accident, nothing on this domain can rank.",
    });
  }

  if (isPathBlocked(groups, auditedPath)) {
    report.blocksAuditedUrl = true;
    report.findings.push({
      severity: "critical",
      message: `robots.txt blocks ${auditedPath}, so this page cannot be crawled or indexed.`,
    });
  }

  // Google renders pages before judging them; blocking assets degrades how the
  // page is scored even though the HTML itself is crawlable.
  const blockedAssets = (wildcard?.disallow ?? []).filter((rule) =>
    /\.(css|js)$|\/(css|js|assets|static|_next)\//i.test(rule)
  );
  if (blockedAssets.length) {
    report.findings.push({
      severity: "warning",
      message: `Blocking CSS/JS (${blockedAssets
        .slice(0, 3)
        .join(", ")}) stops Google rendering the page as a visitor sees it.`,
    });
  }

  if (!sitemaps.length) {
    report.findings.push({
      severity: "warning",
      message: "No Sitemap: directive. Add one so crawlers can find your sitemap without guessing.",
    });
  }

  return report;
}

/* -------------------------------- sitemap.xml ------------------------------ */

/** `<loc>` values, which is all we need from either sitemap shape. */
function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export async function checkSitemap(
  origin: string,
  declaredSitemaps: string[]
): Promise<SitemapReport> {
  const report: SitemapReport = {
    present: false,
    urls: [],
    urlCount: 0,
    isIndex: false,
    bytes: 0,
    findings: [],
  };

  // Prefer what robots.txt declared; fall back to the conventional path.
  const candidates = declaredSitemaps.length ? declaredSitemaps : [`${origin}/sitemap.xml`];

  let xml = "";
  let sourceUrl = "";

  for (const candidate of candidates.slice(0, 3)) {
    try {
      const res = await safeFetch(candidate, {
        timeoutMs: FILE_TIMEOUT,
        maxBytes: 8 * 1024 * 1024,
      });
      if (res.status === 200 && /<(urlset|sitemapindex)/i.test(res.body)) {
        xml = res.body;
        sourceUrl = res.finalUrl;
        report.bytes = Buffer.byteLength(res.body);
        if (res.truncated) {
          report.findings.push({
            severity: "info",
            message: "The sitemap is very large and was only read in part.",
          });
        }
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }

  if (!xml) {
    report.findings.push({
      severity: "warning",
      message:
        "No sitemap found. Without one, search engines discover pages only by following links, and orphaned pages stay invisible.",
    });
    return report;
  }

  report.present = true;
  report.isIndex = /<sitemapindex/i.test(xml);
  report.urls = [sourceUrl];

  let locs = extractLocs(xml);

  // A sitemap index points at more sitemaps; follow one level so the URL count
  // reflects the site rather than the index.
  if (report.isIndex) {
    const children = locs.slice(0, 5);
    report.urls = children;
    let total = 0;

    for (const child of children) {
      try {
        const res = await safeFetch(child, { timeoutMs: FILE_TIMEOUT, maxBytes: 8 * 1024 * 1024 });
        if (res.status === 200) total += extractLocs(res.body).length;
      } catch {
        report.findings.push({
          severity: "warning",
          message: `Sitemap ${child} listed in the index could not be fetched.`,
        });
      }
    }

    report.urlCount = total;
    if (locs.length > 5) {
      report.findings.push({
        severity: "info",
        message: `The index lists ${locs.length} sitemaps; the first 5 were checked.`,
      });
    }
    locs = [];
  } else {
    report.urlCount = locs.length;
  }

  if (report.urlCount === 0 && !report.isIndex) {
    report.findings.push({
      severity: "warning",
      message: "The sitemap contains no URLs.",
    });
  }

  if (report.urlCount > MAX_SITEMAP_URLS) {
    report.findings.push({
      severity: "critical",
      message: `${report.urlCount.toLocaleString()} URLs exceeds the ${MAX_SITEMAP_URLS.toLocaleString()} limit. Split it into a sitemap index or search engines will ignore it.`,
    });
  }

  if (report.bytes > MAX_SITEMAP_BYTES) {
    report.findings.push({
      severity: "critical",
      message: `The sitemap is ${(report.bytes / 1024 / 1024).toFixed(1)} MB, over the 50 MB limit.`,
    });
  }

  // URLs on another host are ignored, and are usually a copy-paste of a staging
  // sitemap that nobody noticed.
  if (locs.length) {
    const expected = new URL(origin).hostname.replace(/^www\./, "");
    const foreign = locs.filter((u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "") !== expected;
      } catch {
        return true;
      }
    });
    if (foreign.length) {
      report.findings.push({
        severity: "warning",
        message: `${foreign.length} URL(s) point at a different host (e.g. ${foreign[0]}). Search engines ignore those.`,
      });
    }
  }

  return report;
}
