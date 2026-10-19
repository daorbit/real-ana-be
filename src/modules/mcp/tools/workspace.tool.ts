import { Site } from "../../analytics/models/Site.js";
import { describeScopes } from "../../mcp-oauth/scopes.js";
import type { ToolDef } from "../tool-runner.js";

const MAX_SITES = 50;

export const getWorkspaceTool: ToolDef<{}> = {
  name: "get_workspace",
  title: "Get workspace",
  description:
    "Returns the Quantalog workspace this connection is authorized for: its name, your role, the permissions granted to this connection, its tracked websites and which apps are enabled. Call this first to understand what data is available.",
  scope: "workspace:read",
  input: {},
  run: async (ctx) => {
    const sites = await Site.find({ workspaceId: ctx.workspaceId })
      .select("siteId name domain platform")
      .limit(MAX_SITES)
      .lean();

    const apps = (ctx.workspace.get("apps") ?? {}) as Record<string, { enabled?: boolean }>;

    return {
      workspace: {
        id: ctx.workspaceId,
        name: ctx.workspace.get("name"),
        createdAt: ctx.workspace.get("createdAt"),
      },
      yourRole: ctx.role,
      permissions: describeScopes(ctx.scopes),
      sites: sites.map((s) => ({ siteId: s.siteId, name: s.name, domain: s.domain, platform: s.platform })),
      enabledApps: Object.entries(apps)
        .filter(([, app]) => app?.enabled)
        .map(([name]) => name),
    };
  },
};
