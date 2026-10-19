import { OAuthCode } from "./models/OAuthCode.js";
import { OAuthGrant } from "./models/OAuthGrant.js";
import { OAuthToken } from "./models/OAuthToken.js";
import { OAuthClient } from "./models/OAuthClient.js";
import { OAuthError } from "./errors.js";
import { hashToken, randomToken, TOKEN_PREFIX, verifyPkce } from "./crypto.js";
import { isRegisteredRedirect } from "./redirect-uri.js";
import { revokeGrant } from "./grant.service.js";
import { isScope, parseScopes, type McpScope } from "./scopes.js";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, resourceUrl } from "./config.js";
import { isDenied, resolveAccessFor } from "../workspace/access.service.js";

const REUSE_GRACE_MS = 30_000;
const USED_REFRESH_RETENTION_MS = 24 * 60 * 60 * 1000;

export type McpAuthContext = {
  grantId: string;
  userId: string;
  workspaceId: string;
  clientId: string;
  scopes: McpScope[];
};

type GrantDoc = {
  _id: unknown;
  userId: unknown;
  workspaceId: unknown;
  clientId: string;
  scopes: string[];
  resource: string;
  revokedAt?: Date | null;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function checkResource(raw: unknown, grantResource: string) {
  if (raw === undefined || raw === "") return;
  if (str(raw).replace(/\/+$/, "") !== grantResource) {
    throw new OAuthError("invalid_target", "resource does not match the authorized MCP endpoint");
  }
}

async function ensureStillMember(grant: GrantDoc) {
  const access = await resolveAccessFor(String(grant.userId), String(grant.workspaceId), "viewer");
  if (isDenied(access)) {
    await revokeGrant(String(grant._id), "membership_removed");
    throw new OAuthError("invalid_grant", "the user no longer has access to this workspace");
  }
}

async function issueTokens(grant: GrantDoc, scopes: McpScope[]) {
  const access = randomToken(TOKEN_PREFIX.access);
  const refresh = randomToken(TOKEN_PREFIX.refresh);
  const now = Date.now();
  const shared = {
    grantId: grant._id,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    clientId: grant.clientId,
    scopes,
    resource: grant.resource,
  };

  await OAuthToken.insertMany([
    { ...shared, tokenHash: hashToken(access), kind: "access", expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000) },
    { ...shared, tokenHash: hashToken(refresh), kind: "refresh", expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000) },
  ]);

  void OAuthClient.updateOne({ clientId: grant.clientId }, { lastUsedAt: new Date() }).catch(() => {});

  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

export async function exchangeAuthorizationCode(body: Record<string, unknown>) {
  const code = str(body.code);
  if (!code.startsWith(TOKEN_PREFIX.code)) throw new OAuthError("invalid_grant", "invalid authorization code");
  const codeHash = hashToken(code);

  const record = await OAuthCode.findOneAndUpdate(
    { codeHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
    { new: true },
  ).lean();

  if (!record) {
    const replayed = await OAuthCode.findOne({ codeHash }).select("grantId usedAt").lean();
    if (replayed?.usedAt) await revokeGrant(String(replayed.grantId), "authorization_code_replay");
    throw new OAuthError("invalid_grant", "authorization code is invalid, expired or already used");
  }

  if (str(body.client_id) !== record.clientId) throw new OAuthError("invalid_grant", "client_id does not match the authorization code");
  if (!isRegisteredRedirect([record.redirectUri], str(body.redirect_uri))) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!verifyPkce(body.code_verifier, record.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");

  const grant = await OAuthGrant.findOne({ _id: record.grantId, revokedAt: null }).lean<GrantDoc>();
  if (!grant) throw new OAuthError("invalid_grant", "this authorization has been revoked");
  checkResource(body.resource, grant.resource);
  await ensureStillMember(grant);

  await OAuthGrant.updateOne({ _id: grant._id }, { activatedAt: new Date(), lastUsedAt: new Date() });
  return issueTokens(grant, grant.scopes.filter(isScope));
}

export async function refreshAccessToken(body: Record<string, unknown>) {
  const raw = str(body.refresh_token);
  if (!raw.startsWith(TOKEN_PREFIX.refresh)) throw new OAuthError("invalid_grant", "invalid refresh token");
  const tokenHash = hashToken(raw);

  const record = await OAuthToken.findOneAndUpdate(
    { tokenHash, kind: "refresh", usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date(), expiresAt: new Date(Date.now() + USED_REFRESH_RETENTION_MS) },
    { new: true },
  ).lean();

  if (!record) {
    const reused = await OAuthToken.findOne({ tokenHash, kind: "refresh" }).select("grantId usedAt").lean();
    if (reused?.usedAt && Date.now() - reused.usedAt.getTime() > REUSE_GRACE_MS) {
      await revokeGrant(String(reused.grantId), "refresh_token_reuse");
    }
    throw new OAuthError("invalid_grant", "refresh token is invalid, expired or already used");
  }

  if (str(body.client_id) !== record.clientId) throw new OAuthError("invalid_grant", "client_id does not match the refresh token");

  const grant = await OAuthGrant.findOne({ _id: record.grantId, revokedAt: null }).lean<GrantDoc>();
  if (!grant) throw new OAuthError("invalid_grant", "this authorization has been revoked");
  checkResource(body.resource, grant.resource);

  const granted = grant.scopes.filter(isScope);
  let scopes = granted;
  if (body.scope !== undefined && body.scope !== "") {
    const asked = parseScopes(body.scope);
    if (!asked || !asked.every((s) => granted.includes(s))) throw new OAuthError("invalid_scope", "scope exceeds the original grant");
    scopes = asked;
  }

  await ensureStillMember(grant);
  return issueTokens(grant, scopes);
}

export async function verifyAccessToken(raw: string): Promise<McpAuthContext | null> {
  if (!raw.startsWith(TOKEN_PREFIX.access) || raw.length > 200) return null;
  const token = await OAuthToken.findOne({
    tokenHash: hashToken(raw),
    kind: "access",
    expiresAt: { $gt: new Date() },
  })
    .select("grantId userId workspaceId clientId scopes resource")
    .lean();

  if (!token || token.resource !== resourceUrl()) return null;

  return {
    grantId: String(token.grantId),
    userId: String(token.userId),
    workspaceId: String(token.workspaceId),
    clientId: token.clientId,
    scopes: token.scopes.filter(isScope),
  };
}

export async function revokeToken(body: Record<string, unknown>): Promise<void> {
  const raw = str(body.token);
  if (!raw.startsWith(TOKEN_PREFIX.access) && !raw.startsWith(TOKEN_PREFIX.refresh)) return;
  const token = await OAuthToken.findOne({ tokenHash: hashToken(raw) }).select("kind grantId clientId").lean();
  if (!token) return;
  if (body.client_id !== undefined && str(body.client_id) !== token.clientId) return;
  if (token.kind === "refresh") await revokeGrant(String(token.grantId), "revoked_by_client");
  else await OAuthToken.deleteOne({ _id: token._id });
}
