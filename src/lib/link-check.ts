import { safeFetch, pooled, BlockedUrlError } from "./safe-fetch.js";

/**
 * Broken link detection.
 *
 * Every anchor on the page is already parsed for the link counts; this actually
 * requests them. Broken links waste crawl budget, strand visitors, and are
 * invisible until someone complains.
 *
 * The constraints below are what keep this a diagnostic rather than an attack
 * tool: a capped number of links, capped concurrency, short timeouts, and
 * every request through the SSRF guard.
 */

export type LinkStatus =
  | "ok"
  | "broken" // 4xx
  | "server-error" // 5xx
  | "redirect" // resolved, but via a chain worth reporting
  | "timeout"
  | "blocked" // refused by the SSRF guard
  | "skipped"; // over the cap

export type LinkResult = {
  url: string;
  /** Visible anchor text, for finding the link on the page. */
  text: string;
  internal: boolean;
  status: LinkStatus;
  statusCode: number | null;
  /** Hops when the link redirected; empty otherwise. */
  chain: string[];
  elapsedMs: number;
  note?: string;
};

export type LinkCheckReport = {
  checked: number;
  /** Links found but not checked because of the cap. */
  skipped: number;
  broken: number;
  serverErrors: number;
  redirects: number;
  timeouts: number;
  results: LinkResult[];
};

/** Above this, checking every link stops being proportionate. */
const MAX_LINKS = 100;
const CONCURRENCY = 8;
const LINK_TIMEOUT = 8_000;

export type PageLink = { url: string; text: string; internal: boolean };

/**
 * Check a page's links.
 *
 * Internal links sort first and are therefore always within the cap: they are
 * the ones the site owner can actually fix, and a page with 300 outbound links
 * should not spend its whole budget on other people's sites.
 */
export async function checkLinks(links: PageLink[]): Promise<LinkCheckReport> {
  // Deduplicate: the same href in a nav repeated across a page is one request.
  const seen = new Map<string, PageLink>();
  for (const link of links) {
    if (!seen.has(link.url)) seen.set(link.url, link);
  }

  const unique = [...seen.values()].sort((a, b) => Number(b.internal) - Number(a.internal));

  const toCheck = unique.slice(0, MAX_LINKS);
  const skipped = unique.slice(MAX_LINKS);

  const results = await pooled(toCheck, CONCURRENCY, async (link) => checkOne(link));

  for (const link of skipped) {
    results.push({
      url: link.url,
      text: link.text,
      internal: link.internal,
      status: "skipped",
      statusCode: null,
      chain: [],
      elapsedMs: 0,
      note: `Not checked — over the ${MAX_LINKS}-link limit for one audit.`,
    });
  }

  return {
    checked: toCheck.length,
    skipped: skipped.length,
    broken: results.filter((r) => r.status === "broken").length,
    serverErrors: results.filter((r) => r.status === "server-error").length,
    redirects: results.filter((r) => r.status === "redirect").length,
    timeouts: results.filter((r) => r.status === "timeout").length,
    results,
  };
}

async function checkOne(link: PageLink): Promise<LinkResult> {
  const base: Omit<LinkResult, "status" | "statusCode" | "chain" | "elapsedMs"> = {
    url: link.url,
    text: link.text,
    internal: link.internal,
  };

  try {
    // HEAD first: it is the polite request, and a link check does not need the
    // body. Plenty of servers mishandle it, so a non-2xx HEAD is retried as a
    // GET before being believed.
    let res = await safeFetch(link.url, { method: "HEAD", timeoutMs: LINK_TIMEOUT });

    if (res.status === 405 || res.status === 501 || res.status === 403 || res.status === 0) {
      res = await safeFetch(link.url, {
        method: "GET",
        timeoutMs: LINK_TIMEOUT,
        maxBytes: 64 * 1024, // enough to confirm it responds; no need for the page
      });
    }

    const redirected = res.chain.length > 1;

    if (res.status >= 400 && res.status < 500) {
      return {
        ...base,
        status: "broken",
        statusCode: res.status,
        chain: redirected ? res.chain : [],
        elapsedMs: res.elapsedMs,
        note: res.status === 404 ? "Page not found." : `Client error ${res.status}.`,
      };
    }

    if (res.status >= 500) {
      return {
        ...base,
        status: "server-error",
        statusCode: res.status,
        chain: redirected ? res.chain : [],
        elapsedMs: res.elapsedMs,
        note: "The target server returned an error. It may be temporary.",
      };
    }

    // A redirect that never resolved means we ran out of hops — a loop, or a
    // chain longer than any crawler will follow.
    if (res.status >= 300 && res.status < 400) {
      return {
        ...base,
        status: "redirect",
        statusCode: res.status,
        chain: res.chain,
        elapsedMs: res.elapsedMs,
        note: "Redirect chain too long to follow — likely a loop.",
      };
    }

    // Resolved fine, but through hops. Worth reporting: each hop costs crawl
    // budget and leaks a little link equity.
    if (redirected) {
      return {
        ...base,
        status: "redirect",
        statusCode: res.status,
        chain: res.chain,
        elapsedMs: res.elapsedMs,
        note:
          res.chain.length > 2
            ? `${res.chain.length - 1} redirects before resolving. Link directly to the final URL.`
            : "Redirects once. Linking straight to the destination is cheaper.",
      };
    }

    return {
      ...base,
      status: "ok",
      statusCode: res.status,
      chain: [],
      elapsedMs: res.elapsedMs,
    };
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      return {
        ...base,
        status: "blocked",
        statusCode: null,
        chain: [],
        elapsedMs: 0,
        note: e.message,
      };
    }

    const message = (e as Error)?.message ?? "request failed";
    // A timeout is a different problem from a 404 with a different fix, so it
    // is reported separately rather than lumped in as "broken".
    const timedOut = /timed out|ETIMEDOUT|ECONNRESET/i.test(message);

    return {
      ...base,
      status: timedOut ? "timeout" : "broken",
      statusCode: null,
      chain: [],
      elapsedMs: 0,
      note: timedOut ? "No response within 8 seconds." : message,
    };
  }
}
