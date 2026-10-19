export const MCP_SCOPES = {
  "workspace:read": "See the workspace name, your role and its connected sites",
  "forms:read": "See your forms, their questions and form analytics",
  "submissions:read": "Read form responses and lead pipeline summaries",
  "bookings:read": "See booking counts and upcoming booked slots",
  "analytics:read": "See website traffic summaries",
} as const;

export type McpScope = keyof typeof MCP_SCOPES;

export const ALL_SCOPES = Object.keys(MCP_SCOPES) as McpScope[];

export function isScope(value: string): value is McpScope {
  return value in MCP_SCOPES;
}

export function parseScopes(raw: unknown): McpScope[] | null {
  if (raw === undefined || raw === null || raw === "") return [...ALL_SCOPES];
  if (typeof raw !== "string") return null;
  const requested = [...new Set(raw.split(" ").map((s) => s.trim()).filter(Boolean))];
  if (!requested.length) return [...ALL_SCOPES];
  if (!requested.every(isScope)) return null;
  return requested as McpScope[];
}

export function describeScopes(scopes: readonly McpScope[]) {
  return scopes.map((scope) => ({ scope, description: MCP_SCOPES[scope] }));
}
