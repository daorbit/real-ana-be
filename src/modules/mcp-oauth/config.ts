const trimSlash = (value: string) => value.replace(/\/+$/, "");

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 5 * 60;
export const AUTH_REQUEST_TTL_SECONDS = 10 * 60;

const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function mcpEnabled(): boolean {
  return process.env.MCP_ENABLED === "true";
}

export function issuerUrl(): string {
  const configured = process.env.MCP_ISSUER_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return trimSlash(configured);
  if (process.env.NODE_ENV === "production") {
    throw new Error("MCP_ISSUER_URL or PUBLIC_BASE_URL must be set to serve the MCP connector");
  }
  return `http://localhost:${process.env.PORT ?? 4000}`;
}

export function resourceUrl(): string {
  return `${issuerUrl()}/mcp`;
}

export function consentPageUrl(): string {
  const base = process.env.MCP_CONSENT_URL || process.env.STUDIO_BASE_URL || "http://localhost:5173";
  return `${trimSlash(base)}/connect/authorize`;
}

export function allowedRedirectHosts(): string[] {
  const raw = process.env.MCP_ALLOWED_REDIRECT_HOSTS;
  if (!raw) return DEFAULT_REDIRECT_HOSTS;
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function allowsLoopbackRedirects(): boolean {
  return process.env.MCP_ALLOW_LOOPBACK_REDIRECTS === "true" || process.env.NODE_ENV !== "production";
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}
