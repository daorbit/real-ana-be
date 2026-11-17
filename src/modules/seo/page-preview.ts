import * as cheerio from "cheerio";
import { safeFetch } from "../../infra/http-client/safe-fetch.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 8_000;
const PREVIEW_MAX_BYTES = 1_500_000;

const STRIPPED = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "base",
  "meta[http-equiv]",
  "link[rel=preload]",
  "link[rel=modulepreload]",
  "link[rel=prefetch]",
  "link[rel=manifest]",
].join(",");

export class PreviewUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewUnavailableError";
  }
}

const previews = createTtlCache<string>(PREVIEW_TTL_MS, 200);

async function loadPreview(url: string): Promise<string> {
  const res = await safeFetch(url, {
    timeoutMs: PREVIEW_TIMEOUT_MS,
    maxBytes: PREVIEW_MAX_BYTES,
    headers: { Accept: "text/html,application/xhtml+xml" },
  });

  if (res.status >= 400) throw new PreviewUnavailableError(`the page answered ${res.status}`);
  const type = res.headers["content-type"] ?? "";
  if (type && !type.includes("html")) throw new PreviewUnavailableError("the page is not HTML");

  const $ = cheerio.load(res.body);
  $(STRIPPED).remove();
  $("img[data-src]").each((_i, el) => {
    const img = $(el);
    img.attr("src", img.attr("data-src") ?? "");
  });
  $("img[data-srcset], source[data-srcset]").each((_i, el) => {
    const node = $(el);
    node.attr("srcset", node.attr("data-srcset") ?? "");
  });
  $("head").prepend(
    `<base href="${encodeURI(res.finalUrl)}" target="_blank"><meta name="referrer" content="no-referrer">`
  );
  return $.html();
}

export function buildPagePreview(workspaceId: string, url: string): Promise<string> {
  return previews(`${workspaceId}:${url}`, () => loadPreview(url));
}
