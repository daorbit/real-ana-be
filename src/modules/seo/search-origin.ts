import type { SiteRef } from "./search-cache.js";
import { hostOf, propertyMatchesDomain } from "./search-console.service.js";

export function propertyOrigins(site: SiteRef): string[] {
  if (!/^sc-domain:/i.test(site.propertyUrl)) {
    try {
      return [new URL(site.propertyUrl).origin];
    } catch {
      return [];
    }
  }
  const domain = site.domain ?? "";
  const host = domain && propertyMatchesDomain(site.propertyUrl, domain) ? hostOf(domain) : hostOf(site.propertyUrl);
  const bare = `https://${host}`;
  const www = `https://www.${host}`;
  return /^(https?:\/\/)?www\./i.test(domain.trim()) ? [www, bare] : [bare, www];
}
