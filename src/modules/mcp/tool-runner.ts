import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpAuthContext } from "../mcp-oauth/token.service.js";
import type { McpScope } from "../mcp-oauth/scopes.js";
import { revokeGrant } from "../mcp-oauth/grant.service.js";
import { isDenied, resolveAccessFor, type Access } from "../workspace/access.service.js";
import { overRateLimit } from "../security/rate-limit.service.js";
import { FormsServiceError } from "../../infra/http-client/forms-service.js";
import { captureServerError } from "../../infra/monitoring/sentry.js";
import { isAppError } from "../../shared/errors/index.js";
import { ToolError, ToolTimeoutError } from "./errors.js";
import { CALLS_PER_MINUTE, MAX_RESPONSE_CHARS, TOOL_TIMEOUT_MS } from "./limits.js";

export type ToolContext = McpAuthContext & Access;

export type ToolDef<S extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  input: S;
  run: (ctx: ToolContext, args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>;
};

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function logCall(auth: McpAuthContext, tool: string, started: number, outcome: string) {
  console.info(
    JSON.stringify({
      evt: "mcp_tool_call",
      tool,
      outcome,
      ms: Date.now() - started,
      grant: auth.grantId,
      user: auth.userId,
      workspace: auth.workspaceId,
      client: auth.clientId,
    }),
  );
}

function describeFailure(err: unknown): { message: string; outcome: string; unexpected: boolean } {
  if (err instanceof ToolError) return { message: err.message, outcome: "invalid", unexpected: false };
  if (err instanceof ToolTimeoutError) {
    return { message: "This request took too long. Try a smaller page or a shorter date range.", outcome: "timeout", unexpected: false };
  }
  if (err instanceof FormsServiceError) {
    if (err.status === 404) return { message: "Not found in this workspace.", outcome: "not_found", unexpected: false };
    if (err.status === 503) return { message: "Forms are not configured on this server.", outcome: "unavailable", unexpected: false };
    if (err.status === 400) return { message: "The forms service rejected these arguments.", outcome: "invalid", unexpected: false };
    return { message: "The forms service is temporarily unavailable. Try again shortly.", outcome: "upstream_error", unexpected: err.status >= 500 };
  }
  if (isAppError(err) && err.status < 500) return { message: err.message, outcome: "refused", unexpected: false };
  return { message: "Something went wrong while reading Quantalog data.", outcome: "error", unexpected: true };
}

export async function runTool<S extends z.ZodRawShape>(
  auth: McpAuthContext,
  def: ToolDef<S>,
  args: z.objectOutputType<S, z.ZodTypeAny>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    if (!auth.scopes.includes(def.scope)) {
      logCall(auth, def.name, started, "forbidden");
      return textResult(`This connection was not granted the ${def.scope} permission.`, true);
    }

    if (await overRateLimit(`mcp:${auth.grantId}`, CALLS_PER_MINUTE, 60_000)) {
      logCall(auth, def.name, started, "rate_limited");
      return textResult(`Rate limit reached (${CALLS_PER_MINUTE} calls per minute). Wait a minute and try again.`, true);
    }

    const access = await resolveAccessFor(auth.userId, auth.workspaceId, "viewer");
    if (isDenied(access)) {
      await revokeGrant(auth.grantId, "membership_removed");
      logCall(auth, def.name, started, "membership_removed");
      return textResult("This connection no longer has access to its workspace. Reconnect Quantalog in Claude.", true);
    }

    const data = await withTimeout(def.run({ ...auth, ...access }, args), TOOL_TIMEOUT_MS);
    const text = JSON.stringify(data);
    if (text.length > MAX_RESPONSE_CHARS) {
      logCall(auth, def.name, started, "too_large");
      return textResult("The result is too large. Ask for fewer items per page or a narrower filter.", true);
    }

    logCall(auth, def.name, started, "ok");
    return textResult(text);
  } catch (err) {
    const failure = describeFailure(err);
    if (failure.unexpected) {
      await captureServerError(err, { method: "MCP", path: def.name, userId: auth.userId });
    }
    logCall(auth, def.name, started, failure.outcome);
    return textResult(failure.message, true);
  }
}

export function registerTool<S extends z.ZodRawShape>(server: McpServer, auth: McpAuthContext, def: ToolDef<S>) {
  if (!auth.scopes.includes(def.scope)) return;
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ((args: z.objectOutputType<S, z.ZodTypeAny>) => runTool(auth, def, args)) as never,
  );
}
