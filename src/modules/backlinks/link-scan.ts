import * as cheerio from "cheerio";
import { safeFetch } from "../../infra/http-client/safe-fetch.js";
import { urlMatchesDomain } from "../seo/seo.service.js";

export type LinkRel = "follow" | "nofollow" | "ugc" | "sponsored";

export type FoundLink = {
  targetUrl: string;
  anchorText: string;
  rel: LinkRel;
  isImage: boolean;
};

export type PageScan = {
  finalUrl: string;
  httpStatus: number;
  matches: Record<string, FoundLink>;
};

const TIMEOUT = 10_000;
const REL_RANK: Record<LinkRel, number> = { follow: 0, sponsored: 1, ugc: 2, nofollow: 3 };

export function parseRel(raw: string, pageNofollow: boolean): LinkRel {
  const tokens = raw.toLowerCase().split(/\s+/);
  if (tokens.includes("sponsored")) return "sponsored";
  if (tokens.includes("ugc")) return "ugc";
  if (tokens.includes("nofollow") || pageNofollow) return "nofollow";
  return "follow";
}

export async function scanPage(url: string, domains: string[]): Promise<PageScan> {
  const res = await safeFetch(url, {
    timeoutMs: TIMEOUT,
    maxRedirects: 5,
    headers: { Accept: "text/html,application/xhtml+xml" },
  });

  const matches: Record<string, FoundLink> = {};
  if (res.status >= 400) return { finalUrl: res.finalUrl, httpStatus: res.status, matches };

  const $ = cheerio.load(res.body);
  const pageNofollow = /nofollow/i.test($('meta[name="robots"]').attr("content") ?? "");

  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(href)) return;

    let absolute: string;
    try {
      absolute = new URL(href, res.finalUrl).href;
    } catch {
      return;
    }

    const domain = domains.find((d) => urlMatchesDomain(absolute, d));
    if (!domain) return;

    const text = $(el).text().replace(/\s+/g, " ").trim();
    const img = $(el).find("img").first();
    const isImage = !text && img.length > 0;
    const link: FoundLink = {
      targetUrl: absolute,
      anchorText: (isImage ? img.attr("alt") ?? "" : text).slice(0, 200),
      rel: parseRel($(el).attr("rel") ?? "", pageNofollow),
      isImage,
    };

    const existing = matches[domain];
    if (!existing || REL_RANK[link.rel] < REL_RANK[existing.rel]) matches[domain] = link;
  });

  return { finalUrl: res.finalUrl, httpStatus: res.status, matches };
}
