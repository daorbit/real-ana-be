import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * HTTP client for URLs the user chose.
 *
 * Several features here fetch addresses that came from a request body: the
 * page being audited, links found on it, a competitor's homepage. A plain
 * `axios.get` on any of those is a server-side request forgery hole — the
 * server sits inside the private network, so "fetch this URL for me" reaches
 * databases, admin panels and cloud metadata endpoints that the caller could
 * never reach directly.
 *
 * Every outbound request to a user-influenced URL must go through here.
 *
 * The defence has three parts, and all three are needed:
 *
 *  1. Resolve the hostname and check every address it maps to.
 *  2. Connect to the *already-validated* address rather than the hostname, so
 *     the name cannot resolve to something else between the check and the
 *     connection (DNS rebinding).
 *  3. Re-run both steps on every redirect hop, because a public URL is allowed
 *     to redirect to a private one.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export type SafeResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Where the request landed after redirects. */
  finalUrl: string;
  /** Every URL in the redirect chain, starting with the one requested. */
  chain: string[];
  /** Milliseconds from request start to response end. */
  elapsedMs: number;
  /** True when the body hit `maxBytes` and was cut short. */
  truncated: boolean;
};

export type SafeFetchOptions = {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  maxRedirects?: number;
  /** Body cap. A hostile or merely large target must not exhaust memory. */
  maxBytes?: number;
  headers?: Record<string, string>;
};

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Quantalog-SEO/1.0";

const DEFAULTS = {
  method: "GET" as const,
  timeoutMs: 15_000,
  maxRedirects: 3,
  maxBytes: 2 * 1024 * 1024,
};

/* ----------------------------- address checks ----------------------------- */

/** Big-endian integer for an IPv4 dotted quad. */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * IPv4 ranges that must never be reachable from a user-supplied URL.
 *
 * `169.254.0.0/16` is the important one on a cloud host: AWS, GCP and Azure all
 * serve instance credentials from `169.254.169.254`, and that single address is
 * the most valuable target an SSRF can reach.
 */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isBlockedV4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip any zone index

  if (addr === "::" || addr === "::1") return true; // unspecified, loopback
  if (addr.startsWith("fe8") || addr.startsWith("fe9")) return true; // link-local
  if (addr.startsWith("fea") || addr.startsWith("feb")) return true;
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique local
  if (addr.startsWith("ff")) return true; // multicast

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms would otherwise
  // slip a blocked v4 address past the v6 checks.
  const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);

  return false;
}

/** True when this literal address must not be connected to. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true; // not an address we can reason about — refuse it
}

/**
 * Resolve a hostname to the addresses we are willing to connect to.
 *
 * Throws if the name does not resolve, or if *any* address it maps to is
 * blocked. Rejecting on any rather than filtering to the safe ones is
 * deliberate: a name resolving to both a public and a private address is a
 * rebinding attempt, not a configuration to work around.
 */
export async function resolveHostSafely(hostname: string): Promise<string[]> {
  // A bare IP in the URL skips DNS, so check it directly.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname))
      throw new BlockedUrlError(`address ${hostname} is not publicly routable`);
    return [hostname];
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BlockedUrlError(`could not resolve ${hostname}`);
  }

  if (!records.length) throw new BlockedUrlError(`could not resolve ${hostname}`);

  for (const r of records) {
    if (isBlockedAddress(r.address))
      throw new BlockedUrlError(
        `${hostname} resolves to ${r.address}, which is not publicly routable`
      );
  }

  return records.map((r) => r.address);
}

/** Scheme and shape check, before any network work happens. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BlockedUrlError(`unsupported scheme: ${url.protocol}`);

  // Credentials in a URL are a redirect-laundering trick and never legitimate
  // for a page we are auditing.
  if (url.username || url.password)
    throw new BlockedUrlError("URLs with embedded credentials are not allowed");

  return url;
}

/* -------------------------------- requesting ------------------------------- */

/**
 * One hop. The host header carries the real hostname while the socket connects
 * to the validated IP — that pairing is what makes rebinding impossible without
 * breaking TLS or virtual hosting.
 */
function requestOnce(
  url: URL,
  ip: string,
  options: Required<Pick<SafeFetchOptions, "method" | "timeoutMs" | "maxBytes">> & {
    headers: Record<string, string>;
  }
): Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }> {
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        // Connect to the address we validated, not the name.
        host: ip,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        // TLS must still be verified against the hostname, not the IP.
        servername: isHttps ? url.hostname : undefined,
        headers: {
          Host: url.host,
          "User-Agent": DEFAULT_UA,
          "Accept-Encoding": "identity",
          ...options.headers,
        },
        timeout: options.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > options.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });

        const done = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        };

        res.on("end", done);
        // Hitting the byte cap destroys the stream, which ends it via "close"
        // rather than "end". That is a complete result, not a failure.
        res.on("close", () => {
          if (truncated) done();
        });
        res.on("error", reject);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`timed out after ${options.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch a user-supplied URL with SSRF protection and manual redirect handling.
 *
 * Redirects are followed by hand rather than by the HTTP client because each
 * hop needs the same validation as the first. A client that follows redirects
 * itself would resolve and connect to the new location without asking us.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {}
): Promise<SafeResponse> {
  const method = opts.method ?? DEFAULTS.method;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const headers = opts.headers ?? {};

  const started = Date.now();
  const chain: string[] = [];

  let url = assertFetchableUrl(rawUrl);
  let hops = 0;

  for (;;) {
    chain.push(url.href);

    const [ip] = await resolveHostSafely(url.hostname);
    const res = await requestOnce(url, ip, { method, timeoutMs, maxBytes, headers });

    const location = res.headers["location"];
    const isRedirect = res.status >= 300 && res.status < 400 && location;

    if (!isRedirect) {
      return {
        status: res.status,
        headers: res.headers,
        body: res.body,
        finalUrl: url.href,
        chain,
        elapsedMs: Date.now() - started,
        truncated: res.truncated,
      };
    }

    if (hops >= maxRedirects) {
      // Not an error: a redirect loop is a finding the link checker reports.
      return {
        status: res.status,
        headers: res.headers,
        body: "",
        finalUrl: url.href,
        chain,
        elapsedMs: Date.now() - started,
        truncated: false,
      };
    }

    // `Location` is allowed to be relative, and resolving it against the
    // current URL is what stops a relative hop escaping the checks.
    let next: URL;
    try {
      next = new URL(location, url.href);
    } catch {
      throw new BlockedUrlError(`invalid redirect target: ${location}`);
    }

    url = assertFetchableUrl(next.href);
    hops++;
  }
}

/* ------------------------------ rate limiting ------------------------------ */

/**
 * Per-key token bucket, held in memory.
 *
 * This is what stops one workspace pointing the link checker at a target and
 * turning the server into a traffic amplifier. In-memory means each serverless
 * instance keeps its own count, which under-counts across instances — but the
 * ceiling it enforces per instance is still far below what would make this
 * useful as an attack tool, and a shared store is not worth the dependency
 * here.
 */
type Bucket = { tokens: number; last: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  { capacity = 30, refillPerMinute = 30 }: { capacity?: number; refillPerMinute?: number } = {}
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: capacity, last: now };

  const refill = ((now - bucket.last) / 60_000) * refillPerMinute;
  bucket.tokens = Math.min(capacity, bucket.tokens + refill);
  bucket.last = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) / refillPerMinute) * 60_000);
    return { allowed: false, retryAfterMs };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * Used wherever a single audit fans out into many requests — checking 100 links
 * one at a time is unusably slow, and all at once is a burst the target reads
 * as an attack.
 */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}
