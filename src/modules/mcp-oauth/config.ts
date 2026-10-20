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

const WORKSPACE_ID = /^[a-f0-9]{24}$/i;

export const MCP_CLIENTS = ["claude", "chatgpt"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export type McpEndpoint = { workspaceId?: string; client?: McpClient };

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID.test(value);
}

function isMcpClient(value: unknown): value is McpClient {
  return typeof value === "string" && (MCP_CLIENTS as readonly string[]).includes(value.toLowerCase());
}

export function endpointFromParams(params: { workspaceId?: unknown; client?: unknown }): McpEndpoint | null {
  const { workspaceId, client } = params;
  if (workspaceId === undefined) return client === undefined ? {} : null;
  if (!isWorkspaceId(workspaceId)) return null;
  if (client !== undefined && !isMcpClient(client)) return null;
  return {
    workspaceId: workspaceId.toLowerCase(),
    ...(client !== undefined ? { client: (client as string).toLowerCase() as McpClient } : {}),
  };
}

export function endpointPath(endpoint: McpEndpoint = {}): string {
  if (!endpoint.workspaceId) return "/mcp";
  return `/mcp/${endpoint.workspaceId}${endpoint.client ? `/${endpoint.client}` : ""}`;
}

export function endpointResourceUrl(endpoint: McpEndpoint = {}): string {
  return `${issuerUrl()}${endpointPath(endpoint)}`;
}

export function parseResource(resource: string): McpEndpoint | null {
  const base = resourceUrl();
  if (resource === base) return {};
  if (!resource.startsWith(`${base}/`)) return null;
  const [workspaceId, client, ...rest] = resource.slice(base.length + 1).split("/");
  if (rest.length) return null;
  return endpointFromParams({ workspaceId, client });
}

export function resourceWorkspaceId(resource: string): string | null {
  return parseResource(resource)?.workspaceId ?? null;
}

export function normalizeResource(raw: string): string | null {
  const endpoint = parseResource(trimSlash(raw));
  return endpoint ? endpointResourceUrl(endpoint) : null;
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
