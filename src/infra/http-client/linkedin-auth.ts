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
 * Identity only. What signing in with LinkedIn asks for.
 *
 * Deliberately without `w_member_social`: LinkedIn renders that scope on the
 * consent screen as "create, modify, and delete posts, comments, and reactions
 * on your behalf" — the full reach of the only publishing permission it offers,
 * not what this app does with it. Asking for that in order to *log in* demands
 * a frightening-sounding grant for something that has nothing to do with
 * posting, and it is the wrong trade at the moment someone is deciding whether
 * to trust the product at all.
 */
export const LINKEDIN_LOGIN_SCOPES = ["openid", "profile", "email"];

/**
 * Identity plus publishing. What connecting an account to post from asks for.
 *
 * The extra scope is requested here and only here, at the point where someone
 * has asked to publish — so the permission arrives attached to the feature that
 * needs it, and the consent wording is answerable rather than baffling.
 */
export const LINKEDIN_PUBLISH_SCOPES = [...LINKEDIN_LOGIN_SCOPES, "w_member_social"];

/**
 * The read scopes that would let us show a member their existing posts and the
 * engagement each one earned — the Sent tab's stats columns.
 *
 * Requested opportunistically and never depended on. LinkedIn derives the scopes
 * an app may ask for from the *products* provisioned on it, not from this list:
 * `r_member_social` belongs to the Community Management API and
 * `r_member_postAnalytics` to Member Post Analytics, neither of which this app
 * has. Asking for a scope no product grants is rejected at the authorize step
 * with `unauthorized_scope_error` — before the consent screen renders — which
 * would break connecting entirely.
 *
 * So the flow asks once, and `buildAuthorizeUrl` falls back to the publish-only
 * list the moment LinkedIn refuses. The day either product is approved, these
 * start being granted and the stats pipeline lights up with no code change; see
 * `canReadAnalytics` for the check that gates it.
 */
export const LINKEDIN_READ_SCOPES = ["r_member_social", "r_member_postAnalytics"];

/** Identity, publishing, and the read scopes that may or may not be granted. */
export const LINKEDIN_FULL_SCOPES = [...LINKEDIN_PUBLISH_SCOPES, ...LINKEDIN_READ_SCOPES];

/**
 * LinkedIn's answer when an app asks for a scope none of its products grant.
 *
 * Arrives as an `error` query parameter on the redirect back, without the user
 * ever seeing a consent screen. Matched by name so the callback can tell it
 * apart from a genuine refusal by the member.
 */
export const UNAUTHORIZED_SCOPE_ERROR = "unauthorized_scope_error";

/**
 * Whether a granted scope string permits reading post analytics.
 *
 * Read from what LinkedIn *granted*, never from what was asked for — the whole
 * point of the fallback above is that the two differ. Everything that renders a
 * statistic checks this first and shows an empty column rather than a zero when
 * it is false, because "no data" and "0 impressions" are different claims.
 */
export function canReadAnalytics(scope: string | undefined): boolean {
  return (scope ?? "").split(/[\s,]+/).includes("r_member_postAnalytics");
}

/** Whether a granted scope string permits listing the member's own posts. */
export function canReadPosts(scope: string | undefined): boolean {
  return (scope ?? "").split(/[\s,]+/).includes("r_member_social");
}

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
  return missingLinkedInConfig().length === 0;
}

/**
 * Which pieces of configuration are absent, by name.
 *
 * Names only — never values. "LinkedIn is not configured" on its own gives an
 * operator nothing to act on: the variables live in two different Vercel
 * projects, and the usual mistake is setting them on the frontend rather than
 * the API, or setting them and not redeploying. Saying which one is missing
 * turns that into a single look.
 */
export function missingLinkedInConfig(): string[] {
  const missing: string[] = [];
  if (!clientId()) missing.push("LINKEDIN_CLIENT_ID");
  if (!clientSecret()) missing.push("LINKEDIN_CLIENT_SECRET");
  // Either of these satisfies the redirect URI; report the pair as one item.
  if (!linkedInRedirectUri()) missing.push("LINKEDIN_REDIRECT_URI (or PUBLIC_BASE_URL)");
  return missing;
}

/**
 * The URL to send the browser to, with `state` carrying our CSRF proof.
 *
 * `URLSearchParams` does the encoding: the scope parameter is space-separated
 * and the redirect URI contains a scheme and slashes, both of which have to
 * survive intact.
 */
export function buildAuthorizeUrl(
  state: string,
  /**
   * `login` asks for identity alone; `connect` adds the publishing scope. See
   * the two scope lists above for why they are not the same request.
   */
  intent: "login" | "connect" = "connect",
  /**
   * Whether to include the analytics read scopes on a connect.
   *
   * True on the first attempt and false on the retry that follows an
   * `unauthorized_scope_error` — see `LINKEDIN_READ_SCOPES`. A login never asks
   * for them: signing in has no use for post history, and the consent screen
   * should stay as small as the feature behind it.
   */
  withReadScopes = true,
): string {
  const scopes = intent === "login"
    ? LINKEDIN_LOGIN_SCOPES
    : withReadScopes
      ? LINKEDIN_FULL_SCOPES
      : LINKEDIN_PUBLISH_SCOPES;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: linkedInRedirectUri(),
    scope: scopes.join(" "),
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
    // LinkedIn's own `error` / `error_description` are named explicitly rather
    // than dumping the response: those two fields are diagnostic and safe,
    // while the whole body echoes the request on some failures — and the
    // request carried the client secret.
    //
    // Worth being specific here because every cause looks the same from
    // outside: a code already used, a code older than its 30-minute life, a
    // `redirect_uri` that differs by one character from the registered one, or
    // a client secret that was rotated. The description names which.
    const detail = [data?.error, data?.error_description]
      .filter((v) => typeof v === "string" && v)
      .join(": ");
    throw new Error(
      `linkedin token exchange failed (status ${status})${detail ? ` — ${detail}` : ""}`,
    );
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
    // Same reasoning as the exchange above: name LinkedIn's error fields, not
    // the whole body. A 403 here usually means the app is missing the "Sign In
    // with LinkedIn using OpenID Connect" product.
    const detail = [data?.error, data?.message, data?.error_description]
      .filter((v) => typeof v === "string" && v)
      .join(": ");
    throw new Error(
      `linkedin userinfo failed (status ${status})${detail ? ` — ${detail}` : ""}`,
    );
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
