import { OAuthClient } from "./models/OAuthClient.js";
import { OAuthError } from "./errors.js";
import { randomToken, TOKEN_PREFIX } from "./crypto.js";
import { validateRedirectUri } from "./redirect-uri.js";

const MAX_REDIRECT_URIS = 5;
const MAX_NAME_LENGTH = 100;
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"];

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "AI assistant";
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, MAX_NAME_LENGTH);
  return name || "AI assistant";
}

function cleanClientUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export async function registerClient(body: Record<string, unknown>) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URLs`);
  }
  const redirectUris = [...new Set(uris.map(validateRedirectUri))];

  const authMethod = body.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    throw new OAuthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
  }

  const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || !grants.every((g) => SUPPORTED_GRANTS.includes(g))) {
    throw new OAuthError("invalid_client_metadata", "grant_types may only include authorization_code and refresh_token");
  }

  const responseTypes = body.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.some((t) => t !== "code")) {
    throw new OAuthError("invalid_client_metadata", "response_types may only include code");
  }

  const client = await OAuthClient.create({
    clientId: randomToken(TOKEN_PREFIX.client, 18),
    clientName: cleanName(body.client_name),
    clientUri: cleanClientUri(body.client_uri),
    redirectUris,
  });

  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function findClient(clientId: unknown) {
  if (typeof clientId !== "string" || !clientId.startsWith(TOKEN_PREFIX.client) || clientId.length > 100) return null;
  return OAuthClient.findOne({ clientId }).select("clientId clientName redirectUris").lean();
}
