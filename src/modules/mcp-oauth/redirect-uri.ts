import { allowedRedirectHosts, allowsLoopbackRedirects, isLoopbackHost } from "./config.js";
import { OAuthError } from "./errors.js";

const MAX_URI_LENGTH = 2000;

export function validateRedirectUri(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URI_LENGTH) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri must be an absolute URL");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri must be an absolute URL");
  }

  if (url.hash || url.username || url.password) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain a fragment or credentials");
  }

  const host = url.hostname.toLowerCase();
  const web = url.protocol === "https:" || url.protocol === "http:";
  if (web && isLoopbackHost(host) && allowsLoopbackRedirects()) return raw;
  if (url.protocol === "https:" && allowedRedirectHosts().includes(host)) return raw;

  throw new OAuthError("invalid_redirect_uri", `redirect_uri host ${host} is not allowed`);
}

function withoutPort(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (!isLoopbackHost(url.hostname)) return null;
    url.port = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isRegisteredRedirect(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const loose = withoutPort(requested);
  return loose !== null && allowsLoopbackRedirects() && registered.some((uri) => withoutPort(uri) === loose);
}

export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}
