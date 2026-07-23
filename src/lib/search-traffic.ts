import { Event } from "../models/Event.js";

/**
 * Organic search traffic, derived from stored referrers.
 *
 * **What this can and cannot tell you.** Google has sent a bare
 * `https://www.google.com/` with no query term since 2011 — "not provided" —
 * and every other major engine followed. Keyword data is simply not recoverable
 * from a referrer header, and any tool claiming otherwise from this data source
 * is guessing.
 *
 * So this reports what the data actually supports: which engines send traffic,
 * which pages they land on, and how that trends. Where a query term genuinely
 * is present — a few smaller engines still pass one — it is surfaced. The UI
 * says all of this plainly rather than implying keyword coverage it does not
 * have.
 */

/** Hostname fragment → display name. Ordered longest-first when matching. */
const ENGINES: { match: string; name: string }[] = [
  { match: "google.", name: "Google" },
  { match: "bing.", name: "Bing" },
  { match: "duckduckgo.", name: "DuckDuckGo" },
  { match: "yahoo.", name: "Yahoo" },
  { match: "yandex.", name: "Yandex" },
  { match: "baidu.", name: "Baidu" },
  { match: "ecosia.", name: "Ecosia" },
  { match: "brave.", name: "Brave" },
  { match: "startpage.", name: "Startpage" },
  { match: "qwant.", name: "Qwant" },
  { match: "naver.", name: "Naver" },
  { match: "seznam.", name: "Seznam" },
  { match: "ask.com", name: "Ask" },
  { match: "aol.", name: "AOL" },
  { match: "perplexity.", name: "Perplexity" },
  { match: "chatgpt.com", name: "ChatGPT" },
  { match: "openai.com", name: "ChatGPT" },
  { match: "copilot.microsoft", name: "Copilot" },
  { match: "gemini.google", name: "Gemini" },
];

/** Query-string keys engines have historically used for the search term. */
const QUERY_KEYS = ["q", "query", "p", "text", "wd", "kw", "search"];

export type EngineBucket = {
  engine: string;
  visits: number;
  visitors: number;
};

export type LandingBucket = {
  path: string;
  visits: number;
  visitors: number;
};

export type TermBucket = {
  term: string;
  visits: number;
};

export type SearchTraffic = {
  /** Organic search visits in the window. */
  visits: number;
  /** Distinct visitors arriving from search. */
  visitors: number;
  /** All visits in the window, for computing organic share. */
  totalVisits: number;
  engines: EngineBucket[];
  landingPages: LandingBucket[];
  /** Query terms actually present in referrers. Usually empty — see above. */
  terms: TermBucket[];
  /** True when at least one referrer carried a term. */
  hasTerms: boolean;
};

/** Which engine a referrer belongs to, or null when it is not a search engine. */
function engineOf(referrer: string): string | null {
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = ENGINES.find((e) => host.includes(e.match));
  return hit ? hit.name : null;
}

/** The search term, when the engine still passes one. Usually null. */
function termOf(referrer: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URL(referrer).searchParams;
  } catch {
    return null;
  }
  for (const key of QUERY_KEYS) {
    const value = params.get(key);
    if (value && value.trim()) return value.trim().toLowerCase().slice(0, 120);
  }
  return null;
}

/**
 * Aggregate organic search arrivals for a site over a time window.
 *
 * Only entry pageviews count: a visitor arriving from Google and then reading
 * four more pages arrived from search once, and counting all five would inflate
 * organic traffic against every other channel.
 */
export async function computeSearchTraffic(
  siteIds: string[],
  since: Date
): Promise<SearchTraffic> {
  const match = {
    siteId: { $in: siteIds },
    ts: { $gte: since },
    type: "pageview",
  };

  const [totalVisits, rows] = await Promise.all([
    Event.countDocuments(match),
    Event.find({ ...match, referrer: { $nin: ["", null] } })
      .select("referrer path visitorHash")
      .lean(),
  ]);

  const engineVisits = new Map<string, { visits: number; visitors: Set<string> }>();
  const landing = new Map<string, { visits: number; visitors: Set<string> }>();
  const terms = new Map<string, number>();
  const allVisitors = new Set<string>();
  let visits = 0;

  for (const row of rows) {
    const referrer = String(row.referrer ?? "");
    const engine = engineOf(referrer);
    if (!engine) continue;

    visits++;
    const visitor = String(row.visitorHash ?? "");
    if (visitor) allVisitors.add(visitor);

    const e = engineVisits.get(engine) ?? { visits: 0, visitors: new Set<string>() };
    e.visits++;
    if (visitor) e.visitors.add(visitor);
    engineVisits.set(engine, e);

    const path = String(row.path ?? "/");
    const l = landing.get(path) ?? { visits: 0, visitors: new Set<string>() };
    l.visits++;
    if (visitor) l.visitors.add(visitor);
    landing.set(path, l);

    const term = termOf(referrer);
    if (term) terms.set(term, (terms.get(term) ?? 0) + 1);
  }

  return {
    visits,
    visitors: allVisitors.size,
    totalVisits,
    engines: [...engineVisits.entries()]
      .map(([engine, v]) => ({ engine, visits: v.visits, visitors: v.visitors.size }))
      .sort((a, b) => b.visits - a.visits),
    landingPages: [...landing.entries()]
      .map(([path, v]) => ({ path, visits: v.visits, visitors: v.visitors.size }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 25),
    terms: [...terms.entries()]
      .map(([term, visits]) => ({ term, visits }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 25),
    hasTerms: terms.size > 0,
  };
}
