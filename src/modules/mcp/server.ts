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
import { createTaskTool, getTaskBoardTool, getTaskTool, listTasksTool, updateTaskTool } from "./tools/tasks.tools.js";
import { createNoteTool, getNoteTool, listNotesTool, updateNoteTool } from "./tools/notes.tools.js";

const INSTRUCTIONS =
  "Access to one Quantalog workspace. Read forms, form responses, lead pipeline, bookings and website analytics. " +
  "Read, create and update tasks on the workspace's Tasks board, and the user's own personal notes. Nothing can be deleted. " +
  "Start with get_workspace. Use list_forms to find form ids before calling get_form_details or list_submissions. " +
  "Call get_task_board before creating or assigning tasks, to get column and member ids. " +
  "Confirm with the user before creating or changing several tasks or notes at once. " +
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
  registerTool(server, auth, getTaskBoardTool);
  registerTool(server, auth, listTasksTool);
  registerTool(server, auth, getTaskTool);
  registerTool(server, auth, createTaskTool);
  registerTool(server, auth, updateTaskTool);
  registerTool(server, auth, listNotesTool);
  registerTool(server, auth, getNoteTool);
  registerTool(server, auth, createNoteTool);
  registerTool(server, auth, updateNoteTool);

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
