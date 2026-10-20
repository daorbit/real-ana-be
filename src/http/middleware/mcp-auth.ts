import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type McpAuthContext } from "../../modules/mcp-oauth/token.service.js";
import { touchGrant } from "../../modules/mcp-oauth/grant.service.js";
import { protectedResourceMetadataUrl } from "../../modules/mcp-oauth/metadata.js";
import { endpointFromParams, type McpEndpoint } from "../../modules/mcp-oauth/config.js";
import { ALL_SCOPES } from "../../modules/mcp-oauth/scopes.js";

export interface McpRequest extends Request {
  mcpAuth?: McpAuthContext;
}

function challenge(res: Response, endpoint: McpEndpoint, error?: "invalid_token", description?: string) {
  const parts = [
    `resource_metadata="${protectedResourceMetadataUrl(endpoint)}"`,
    `scope="${ALL_SCOPES.join(" ")}"`,
    ...(error ? [`error="${error}"`, `error_description="${description}"`] : []),
  ];
  res.set("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
  res.status(401).json({ error: error ?? "unauthorized", error_description: description ?? "authorization required" });
}

export async function requireMcpToken(req: McpRequest, res: Response, next: NextFunction) {
  const endpoint = endpointFromParams(req.params);
  if (!endpoint) return res.status(404).json({ error: "not found" });

  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return challenge(res, endpoint);

  const auth = await verifyAccessToken(token, endpoint);
  if (!auth) return challenge(res, endpoint, "invalid_token", "the access token is invalid, expired or revoked");

  touchGrant(auth.grantId);
  req.mcpAuth = auth;
  next();
}
