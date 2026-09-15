
import { ORBIT_KNOWLEDGE_FALLBACK } from "./prompt.js";

const CORPUS_URL =
  process.env.ORBIT_CORPUS_URL ?? "https://quantalog.daorbit.in/docs/corpus.txt";

const REFRESH_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

/** Below this, treat the response as a broken deploy rather than real docs. */
const MIN_PLAUSIBLE_CHARS = 2_000;

type CacheState = {
  text: string;
  fetchedAt: number;
  /** False while serving the compiled-in fallback. */
  live: boolean;
};

let cache: CacheState = {
  text: ORBIT_KNOWLEDGE_FALLBACK,
  fetchedAt: 0,
  live: false,
};

/**
 * The in-flight refresh, so a burst of questions on a cold cache makes one
 * request rather than one each.
 */
let inFlight: Promise<void> | null = null;

async function fetchCorpus(): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(CORPUS_URL, {
      signal: abort.signal,
      headers: { Accept: "text/markdown, text/plain" },
    });

    if (!res.ok) {
      console.warn(`[orbit] corpus fetch failed: ${res.status}`);
      return null;
    }

    const text = (await res.text()).trim();

    // A 200 carrying an error page or a half-built route would otherwise
    // replace the whole reference with something shorter than useless.
    if (text.length < MIN_PLAUSIBLE_CHARS || !text.includes("## ")) {
      console.warn(`[orbit] corpus implausible (${text.length} chars), keeping previous`);
      return null;
    }

    return text;
  } catch (e) {
    console.warn(
      `[orbit] corpus fetch error: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refresh(): Promise<void> {
  const text = await fetchCorpus();
  if (text) cache = { text, fetchedAt: Date.now(), live: true };
  // On failure the previous copy stands: stale documentation answers a question
  // far better than an assistant that has forgotten the product.
}

/**
 * The product reference, refreshed in the background.
 *
 * Never awaits a fetch on the request path. A question arriving against a stale
 * or cold cache is answered from what is already held while the refresh runs
 * behind it — the alternative is every user paying the latency of a docs fetch
 * so that one of them gets an answer minutes fresher.
 */
export function orbitKnowledge(): string {
  const age = Date.now() - cache.fetchedAt;

  if (!inFlight && (age > REFRESH_MS || !cache.live)) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }

  return cache.text;
}

/** Warm the cache at boot so the first question is not answered from the stub. */
export function primeOrbitKnowledge(): void {
  if (inFlight) return;
  inFlight = refresh().finally(() => {
    inFlight = null;
  });
}

export function orbitKnowledgeStatus(): {
  live: boolean;
  chars: number;
  ageMs: number | null;
} {
  return {
    live: cache.live,
    chars: cache.text.length,
    ageMs: cache.fetchedAt ? Date.now() - cache.fetchedAt : null,
  };
}
