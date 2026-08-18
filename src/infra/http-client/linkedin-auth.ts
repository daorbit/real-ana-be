import axios from "axios";

/**
 * LinkedIn's OAuth 2.0 authorization-code flow.
 *
 * Unlike the Google integration beside this file, which verifies an ID token
 * the browser already holds, LinkedIn is a full three-legged flow: the user is
 * redirected away, comes back with a code, and the code is traded for a token
 * here. That trade needs the client secret, which is why none of this can move
 * to the frontend.
 */

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";

/**
 * `w_member_social` is requested alongside the OpenID trio now, even though
 * posting is not implemented yet: scopes are granted at authorisation time, and
 * asking for it later would mean sending every connected user back through the
 * consent screen a second time.
 */
export const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"];

export type LinkedInProfile = {
  /** LinkedIn's stable member identifier. */
  sub: string;
  name: string;
  givenName: string;
  familyName: string;
  email: string;
  picture: string;
};

export type LinkedInToken = {
  accessToken: string;
  /** Absolute expiry, computed from the relative `expires_in` LinkedIn returns. */
  expiresAt: Date;
  scope: string;
};

function clientId(): string {
  return process.env.LINKEDIN_CLIENT_ID ?? "";
}

function clientSecret(): string {
  return process.env.LINKEDIN_CLIENT_SECRET ?? "";
}

/**
 * The redirect URI, which must match the LinkedIn app's registered value byte
 * for byte — LinkedIn compares it as a string, and a trailing slash is enough
 * to fail the exchange.
 *
 * Falls back to the API's own public base URL so a correctly-configured
 * deployment does not need the variable set twice.
 */
export function linkedInRedirectUri(): string {
  const explicit = process.env.LINKEDIN_REDIRECT_URI;
  if (explicit) return explicit;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/api/auth/linkedin/callback` : "";
}

/** Whether the deployment has enough configuration to attempt the flow at all. */
export function linkedInConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && linkedInRedirectUri());
}

/**
 * The URL to send the browser to, with `state` carrying our CSRF proof.
 *
 * `URLSearchParams` does the encoding: the scope parameter is space-separated
 * and the redirect URI contains a scheme and slashes, both of which have to
 * survive intact.
 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: linkedInRedirectUri(),
    scope: LINKEDIN_SCOPES.join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Trade an authorization code for an access token.
 *
 * Throws a plain `Error` on failure. The caller turns that into a redirect
 * carrying a generic reason code — LinkedIn's own error text is not something
 * to put in front of a user, and it is not logged either, because the failing
 * request body contains the client secret.
 */
export async function exchangeCodeForToken(code: string): Promise<LinkedInToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: linkedInRedirectUri(),
  });

  const { status, data } = await axios.post(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
    validateStatus: () => true,
  });

  if (status !== 200 || !data?.access_token) {
    // Deliberately no response body in the message: it echoes the request on
    // some failures, and the request carried the client secret.
    throw new Error(`linkedin token exchange failed (status ${status})`);
  }

  // LinkedIn documents ~60 days. The fallback keeps a missing field from
  // producing an Invalid Date that would read as permanently expired.
  const seconds = Number(data.expires_in) || 60 * 24 * 60 * 60;

  return {
    accessToken: String(data.access_token),
    expiresAt: new Date(Date.now() + seconds * 1000),
    scope: String(data.scope ?? ""),
  };
}

/**
 * Fetch the member's profile from the OpenID userinfo endpoint.
 *
 * `sub` and nothing else is treated as required: LinkedIn omits `email` when
 * the member has no verified address, and a connection is still perfectly
 * usable without one.
 */
export async function fetchLinkedInProfile(accessToken: string): Promise<LinkedInProfile> {
  const { status, data } = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
    validateStatus: () => true,
  });

  if (status !== 200 || !data?.sub) {
    throw new Error(`linkedin userinfo failed (status ${status})`);
  }

  const given = String(data.given_name ?? "").trim();
  const family = String(data.family_name ?? "").trim();

  return {
    sub: String(data.sub),
    // LinkedIn usually sends `name`, but it is composed from the parts when
    // absent so the panel never has to render an empty "Connected as".
    name: String(data.name ?? "").trim() || [given, family].filter(Boolean).join(" "),
    givenName: given,
    familyName: family,
    email: String(data.email ?? "").toLowerCase().trim(),
    picture: String(data.picture ?? ""),
  };
}

/**
 * Ask LinkedIn to invalidate a token we are about to forget.
 *
 * Best-effort by design: the local row is deleted either way, because a user
 * who clicked Disconnect must end up disconnected even if LinkedIn is down.
 * Returns whether the call was accepted, only so the caller can log it.
 */
export async function revokeLinkedInToken(accessToken: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      token: accessToken,
    });
    const { status } = await axios.post(REVOKE_URL, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 8000,
      validateStatus: () => true,
    });
    return status === 200;
  } catch {
    return false;
  }
}
