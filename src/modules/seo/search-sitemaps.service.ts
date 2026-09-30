import { SearchConsoleConnection } from "./models/SearchConsoleConnection.js";
import { SearchConsoleProperty } from "./models/SearchConsoleProperty.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  canWriteSearchConsole,
  deleteSearchConsoleSitemap,
  submitSearchConsoleSitemap,
} from "../../infra/http-client/search-console.js";
import { badRequest } from "../../shared/errors/index.js";
import {
  explainSearchConsoleError,
  forgetSearchSitemaps,
  getSearchSitemaps,
  propertyMatchesDomain,
  usableSearchConsoleToken,
  type SearchSitemaps,
  type SiteRef,
} from "./search-console.service.js";

const WRITE_PERMISSIONS = ["siteOwner", "siteFullUser"];

export type SitemapWriteBlock = "scope" | "permission";

export type SitemapAccess = {
  canSubmit: boolean;
  blockedBy: SitemapWriteBlock | null;
};

export class SitemapWriteDenied extends Error {
  readonly blockedBy: SitemapWriteBlock;

  constructor(blockedBy: SitemapWriteBlock) {
    super(
      blockedBy === "scope"
        ? "Reconnect Google to allow Quantalog to submit sitemaps."
        : "Your Google account needs Owner or Full access to this property to submit sitemaps.",
    );
    this.name = "SitemapWriteDenied";
    this.blockedBy = blockedBy;
  }
}

export async function sitemapAccess(site: SiteRef): Promise<SitemapAccess> {
  const [connection, link] = await Promise.all([
    SearchConsoleConnection.findById(site.connectionId).select("scope"),
    SearchConsoleProperty.findOne({ siteId: site.siteId }).select("permissionLevel"),
  ]);

  if (!canWriteSearchConsole(String(connection?.get("scope") ?? ""))) {
    return { canSubmit: false, blockedBy: "scope" };
  }
  if (!WRITE_PERMISSIONS.includes(String(link?.get("permissionLevel") ?? ""))) {
    return { canSubmit: false, blockedBy: "permission" };
  }
  return { canSubmit: true, blockedBy: null };
}

export function sitemapInProperty(propertyUrl: string, sitemap: string): boolean {
  let url: URL;
  try {
    url = new URL(sitemap);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (/^sc-domain:/i.test(propertyUrl)) return propertyMatchesDomain(propertyUrl, url.hostname);
  return url.href.startsWith(propertyUrl);
}

function normalizedSitemap(site: SiteRef, value: unknown): string {
  const raw = String(value ?? "").trim().slice(0, 2048);
  if (!raw) throw badRequest("Enter the sitemap URL");
  if (!sitemapInProperty(site.propertyUrl, raw)) {
    throw badRequest(`The sitemap must be a full URL inside ${site.propertyUrl.replace(/^sc-domain:/i, "")}`);
  }
  return new URL(raw).href;
}

async function writeSitemap(
  site: SiteRef,
  value: unknown,
  write: (accessToken: string, siteUrl: string, feedpath: string) => Promise<void>,
): Promise<SearchSitemaps> {
  const feedpath = normalizedSitemap(site, value);
  const access = await sitemapAccess(site);
  if (access.blockedBy) throw new SitemapWriteDenied(access.blockedBy);

  const accessToken = await usableSearchConsoleToken(site.connectionId);
  await write(accessToken, site.propertyUrl, feedpath);
  await forgetSearchSitemaps(site);
  return getSearchSitemaps(site);
}

export function submitSitemap(site: SiteRef, value: unknown): Promise<SearchSitemaps> {
  return writeSitemap(site, value, submitSearchConsoleSitemap);
}

export function removeSitemap(site: SiteRef, value: unknown): Promise<SearchSitemaps> {
  return writeSitemap(site, value, deleteSearchConsoleSitemap);
}

export function explainSitemapWriteError(err: unknown): string {
  if (err instanceof GoogleApiError) {
    if (err.kind === "forbidden") return new SitemapWriteDenied("permission").message;
    if (err.kind === "not_enabled" && /scope/i.test(err.message)) return new SitemapWriteDenied("scope").message;
    if (err.kind === "not_found") return "Google could not find that sitemap for this property.";
  }
  return explainSearchConsoleError(err);
}
