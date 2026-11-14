import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { linkUrl } from "./bio-draft.js";
import { CUSTOM_SERVICE_ID, detectService } from "./service-catalog.js";

const TIMEOUT_MS = 4000;

export type ResolvedLink = { service: string; url: string; title: string; artist: string; artworkUrl: string };

type OEmbed = { title?: string; author_name?: string; thumbnail_url?: string };

const OEMBED: Record<string, (url: string) => string> = {
  spotify: (url) => `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  "spotify-podcasts": (url) => `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  youtube: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  "youtube-music": (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.replace("music.youtube.com", "www.youtube.com"))}`,
  soundcloud: (url) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  deezer: (url) => `https://api.deezer.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  "apple-music": (url) => `https://music.apple.com/api/oembed?url=${encodeURIComponent(url)}`,
};

const cache = createTtlCache<ResolvedLink>(24 * 60 * 60 * 1000, 500);

function httpsImage(value: unknown): string {
  const url = String(value ?? "");
  return /^https:\/\//i.test(url) ? url.slice(0, 2000) : "";
}

async function fetchOEmbed(endpoint: string): Promise<OEmbed | null> {
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as OEmbed;
  } catch {
    return null;
  }
}

function splitTitle(service: string, data: OEmbed): { title: string; artist: string } {
  const title = String(data.title ?? "").slice(0, 100);
  const author = String(data.author_name ?? "").slice(0, 60);
  if (service === "youtube" || service === "youtube-music") return { title, artist: author.replace(/\s*-\s*Topic$/i, "") };
  return { title, artist: author };
}

export async function resolveBioLink(raw: string): Promise<ResolvedLink | null> {
  const url = linkUrl(raw);
  if (!url || !/^https?:/i.test(url)) return null;
  return cache(url, async () => {
    const service = detectService(url)?.id ?? CUSTOM_SERVICE_ID;
    const endpoint = OEMBED[service];
    const data = endpoint ? await fetchOEmbed(endpoint(url)) : null;
    if (!data) return { service, url, title: "", artist: "", artworkUrl: "" };
    return { service, url, ...splitTitle(service, data), artworkUrl: httpsImage(data.thumbnail_url) };
  });
}
