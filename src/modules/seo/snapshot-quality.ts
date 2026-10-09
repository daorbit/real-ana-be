import type { CheerioAPI } from "cheerio";

export type SnapshotQuality = {
  blocked: boolean;
  clientRendered: boolean;
  redirectedHost: string;
};

export type ReadIssue = "blocked" | "http-error";

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

const CHALLENGE_TITLE = /just a moment|attention required|access denied|are you a robot|verify you are human|security check|captcha|ddos protection|request rejected|pardon our interruption/i;

const CHALLENGE_MARKUP = /cf-chl|challenge-platform|cf_chl_opt|_incapsula_resource|px-captcha|perimeterx|datadome|g-recaptcha|h-captcha|turnstile/i;

const APP_ROOTS = "#root, #__next, #app, #__nuxt, [data-reactroot], app-root";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function assessSnapshot(input: {
  $: CheerioAPI;
  html: string;
  status: number;
  title: string;
  wordCount: number;
  requestedUrl: string;
  finalUrl: string;
}): SnapshotQuality {
  const { $, html, status, title, wordCount } = input;

  const blocked =
    BLOCK_STATUSES.has(status) ||
    CHALLENGE_TITLE.test(title) ||
    (wordCount < 150 && CHALLENGE_MARKUP.test(html));

  const scripts = $("script[src]").length;
  const emptyAppRoot = $(APP_ROOTS)
    .toArray()
    .some((el) => $(el).text().replace(/\s+/g, "").length < 40);
  const clientRendered = !blocked && wordCount < 80 && (emptyAppRoot || scripts >= 3);

  const requested = hostOf(input.requestedUrl);
  const final = hostOf(input.finalUrl);
  const sameSite = !requested || !final || final === requested || final.endsWith(`.${requested}`) || requested.endsWith(`.${final}`);

  return { blocked, clientRendered, redirectedHost: sameSite ? "" : final };
}

export function readIssue(snapshot: { statusCode: number; quality?: SnapshotQuality }): ReadIssue | null {
  if (snapshot.quality?.blocked) return "blocked";
  if (snapshot.statusCode >= 400) return "http-error";
  return null;
}
