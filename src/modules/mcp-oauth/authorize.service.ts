import { OAuthAuthRequest } from "./models/OAuthAuthRequest.js";
import { OAuthCode } from "./models/OAuthCode.js";
import { OAuthGrant } from "./models/OAuthGrant.js";
import { findClient } from "./client.service.js";
import type { OAuthErrorCode } from "./errors.js";
import { hashToken, isValidChallenge, randomToken, TOKEN_PREFIX } from "./crypto.js";
import { isRegisteredRedirect, redirectHost } from "./redirect-uri.js";
import { describeScopes, isScope, parseScopes } from "./scopes.js";
import {
  AUTH_CODE_TTL_SECONDS,
  AUTH_REQUEST_TTL_SECONDS,
  consentPageUrl,
  issuerUrl,
  normalizeResource,
  resourceUrl,
  resourceWorkspaceId,
} from "./config.js";
import { accessibleWorkspaces, isDenied, resolveAccessFor } from "../workspace/access.service.js";
import { notFound } from "../../shared/errors/index.js";

const MAX_STATE_LENGTH = 500;

export class UnredirectableError extends Error {}

export class AuthorizeRedirect extends Error {
  constructor(readonly location: string) {
    super("authorization error redirect");
  }
}

export function errorRedirect(redirectUri: string, code: OAuthErrorCode, description: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuerUrl());
  return url.toString();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function startAuthorization(query: Record<string, unknown>): Promise<string> {
  const client = await findClient(query.client_id);
  if (!client) throw new UnredirectableError("Unknown client. Remove the connector and add it again.");

  const redirectUri = str(query.redirect_uri);
  if (!redirectUri || !isRegisteredRedirect(client.redirectUris, redirectUri)) {
    throw new UnredirectableError("The redirect address does not match the one this client registered.");
  }

  const state = str(query.state).slice(0, MAX_STATE_LENGTH);
  const fail = (code: OAuthErrorCode, description: string): never => {
    throw new AuthorizeRedirect(errorRedirect(redirectUri, code, description, state));
  };

  if (query.response_type !== "code") fail("unsupported_response_type", "response_type must be code");
  if (query.code_challenge_method !== "S256") fail("invalid_request", "code_challenge_method must be S256");
  if (!isValidChallenge(query.code_challenge)) return fail("invalid_request", "a valid PKCE code_challenge is required");

  const scopes = parseScopes(query.scope);
  if (!scopes) return fail("invalid_scope", "unknown scope requested");

  const resource = normalizeResource(query.resource === undefined ? resourceUrl() : str(query.resource));
  if (!resource) return fail("invalid_target", "resource must be this server's MCP endpoint");

  const raw = randomToken(TOKEN_PREFIX.request, 24);
  await OAuthAuthRequest.create({
    requestHash: hashToken(raw),
    clientId: client.clientId,
    redirectUri,
    codeChallenge: query.code_challenge,
    state,
    scopes,
    resource,
    expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_SECONDS * 1000),
  });

  const consent = new URL(consentPageUrl());
  consent.searchParams.set("request", raw);
  return consent.toString();
}

async function loadRequest(raw: unknown) {
  if (typeof raw !== "string" || !raw.startsWith(TOKEN_PREFIX.request) || raw.length > 100) throw notFound("authorization request not found");
  const request = await OAuthAuthRequest.findOne({ requestHash: hashToken(raw), expiresAt: { $gt: new Date() } }).lean();
  if (!request) throw notFound("this authorization request has expired — start the connection again from Claude");
  return request;
}

async function consumeRequest(raw: string) {
  const request = await OAuthAuthRequest.findOneAndDelete({
    requestHash: hashToken(raw),
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!request) throw notFound("this authorization request has expired — start the connection again from Claude");
  return request;
}

export async function describeRequest(raw: unknown, userId: string) {
  const request = await loadRequest(raw);
  const [client, workspaces] = await Promise.all([findClient(request.clientId), accessibleWorkspaces(userId)]);
  if (!client) throw notFound("authorization request not found");

  const locked = resourceWorkspaceId(request.resource);
  const allowed = locked ? workspaces.filter(({ workspace }) => String(workspace.id) === locked) : workspaces;
  if (locked && !allowed.length) throw notFound("you are not a member of the workspace in this connector URL");

  return {
    client: { name: client.clientName, redirectHost: redirectHost(request.redirectUri) },
    scopes: describeScopes(request.scopes.filter(isScope)),
    workspaces: allowed.map(({ workspace, role }) => ({ id: workspace.id as string, name: workspace.name as string, role })),
    expiresAt: request.expiresAt,
  };
}

export async function approveRequest(raw: string, userId: string, workspaceId: unknown) {
  const pending = await loadRequest(raw);
  const chosen = resourceWorkspaceId(pending.resource) ?? (typeof workspaceId === "string" ? workspaceId : undefined);
  const access = await resolveAccessFor(userId, chosen, "viewer");
  if (isDenied(access)) throw notFound("workspace not found");

  const [request, client] = await Promise.all([consumeRequest(raw), findClient(pending.clientId)]);
  if (!client) throw notFound("authorization request not found");

  const grant = await OAuthGrant.create({
    userId,
    workspaceId: access.workspace._id,
    clientId: client.clientId,
    clientName: client.clientName,
    scopes: request.scopes,
    resource: request.resource,
  });

  const code = randomToken(TOKEN_PREFIX.code);
  await OAuthCode.create({
    codeHash: hashToken(code),
    grantId: grant._id,
    clientId: client.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
  });

  const url = new URL(request.redirectUri);
  url.searchParams.set("code", code);
  if (request.state) url.searchParams.set("state", request.state);
  url.searchParams.set("iss", issuerUrl());

  return {
    redirectUrl: url.toString(),
    workspaceId: String(access.workspace._id),
    clientName: client.clientName,
  };
}

export async function denyRequest(raw: string) {
  const request = await consumeRequest(raw);
  return { redirectUrl: errorRedirect(request.redirectUri, "access_denied", "The user declined the connection", request.state) };
}
