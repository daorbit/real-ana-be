import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpAuthContext } from "../mcp-oauth/token.service.js";
import { issuerUrl } from "../mcp-oauth/config.js";
import { registerTool } from "./tool-runner.js";
import { getWorkspaceTool } from "./tools/workspace.tool.js";
import { getFormDetailsTool, listFormsTool } from "./tools/forms.tools.js";
import { listSubmissionsTool } from "./tools/submissions.tool.js";
import { getBookingSummaryTool, getLeadSummaryTool } from "./tools/summaries.tools.js";
import { getAnalyticsSummaryTool } from "./tools/analytics.tool.js";

const INSTRUCTIONS =
  "Read-only access to one Quantalog workspace: forms, form responses, lead pipeline, bookings and website analytics. " +
  "Start with get_workspace. Use list_forms to find form ids before calling get_form_details or list_submissions. " +
  "Results are paginated; request further pages only when needed.";

export function buildMcpServer(auth: McpAuthContext): McpServer {
  const server = new McpServer(
    {
      name: "quantalog",
      title: "Quantalog",
      version: "1.0.0",
      websiteUrl: "https://quantalog.daorbit.in",
      icons: [{ src: `${issuerUrl()}/favicon.png`, mimeType: "image/png", sizes: ["256x256"] }],
    },
    { instructions: INSTRUCTIONS },
  );

  registerTool(server, auth, getWorkspaceTool);
  registerTool(server, auth, listFormsTool);
  registerTool(server, auth, getFormDetailsTool);
  registerTool(server, auth, listSubmissionsTool);
  registerTool(server, auth, getLeadSummaryTool);
  registerTool(server, auth, getBookingSummaryTool);
  registerTool(server, auth, getAnalyticsSummaryTool);

  return server;
}

export async function handleMcpRequest(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  auth: McpAuthContext,
): Promise<void> {
  const server = buildMcpServer(auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
