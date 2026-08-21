import axios from "axios";

/**
 * Instagram Login's OAuth 2.0 authorization-code flow.
 *
 * This is the *Instagram Login* flow — the one configured on this app's Meta
 * dashboard under "Instagram > API setup with Instagram login" — not Facebook
 * Login for Business and not the retired Basic Display API. The distinction is
 * not cosmetic: the authorize and token hosts below are `instagram.com` and
 * `api.instagram.com`, and the credential they accept is the *Instagram* app id
 * and secret, which are different numbers from the Meta app id even though both
 * live on the same Meta app.
 *
 * The shape follows `linkedin-auth.ts` beside this file — same three-legged
 * exchange, same "the secret never leaves the server" reason for existing — with
 * one extra hop LinkedIn does not have: the code exchange returns a short-lived
 * token good for an hour, which has to be traded again for the 60-day one that
 * is actually worth storing. See `exchangeCodeForToken`.
 */

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
/** Where the short-lived token is upgraded, and where a stored one is refreshed. */
const GRAPH_URL = "https://graph.instagram.com";

/**
 * The permissions this integration asks for.
 *
 * `instagram_business_basic` is the identity read — the username and account id
 * the panel shows. `instagram_business_content_publish` is what the scheduler
 * needs to create and publish a media container.
 *
 * Deliberately shorter than the list in the dashboard's sample consent URL,
 * which also asks for messages, comments and insights. Nothing here reads a DM
 * or a comment, and a consent screen that asks for a person's inbox in order to
 * post a picture is the wrong trade — the same reasoning that keeps
 * `w_member_social` off the LinkedIn sign-in.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
];

/** Whether a granted scope string permits publishing. */
export function canPublish(scope: string | undefined): boolean {
  return (scope ?? "").split(/[\s,]+/).includes("instagram_business_content_publish");
}

export type InstagramProfile = {
  /** The Instagram-scoped account id. Stable, and what the publish calls address. */
  userId: string;
  username: string;
  accountType: string;
  picture: string;
};

export type InstagramToken = {
  accessToken: string;
  /** Absolute expiry, computed from the relative `expires_in` Instagram returns. */
  expiresAt: Date;
  scope: string;
  /** The account the token belongs to, which the exchange already reports. */
  userId: string;
};

/**
 * The Instagram app credentials.
 *
 * `INSTAGRAM_APP_ID` first, `META_APP_ID` as a fallback. They are not the same
 * value: the Instagram app id is the one the "API setup with Instagram login"
 * panel shows, and it is the only one `api.instagram.com` accepts — passing the
 * Meta app id here fails the exchange with an unhelpful client error. The
 * fallback exists for a deployment that only ever set the Meta pair, which is
 * how the variables were first written down.
 */
function clientId(): string {
  return process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || "";
}

function clientSecret(): string {
  return process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || "";
}

/**
 * The redirect URI, which Instagram matches against its registered list byte for
 * byte — a trailing slash or a missing `/api` is enough to fail the exchange.
 *
 * Note this deliberately does *not* fall back to `PUBLIC_BASE_URL + /api/...`
 * the way the LinkedIn one does: the value registered in the Meta dashboard is
 * the bare `/auth/instagram/callback` path, so the alias routes in `app.ts`
 * exist to serve it. Guessing a different path here would produce a URL that
 * looks right and is rejected.
 */
export function instagramRedirectUri(): string {
  const explicit = process.env.INSTAGRAM_REDIRECT_URI;
  if (explicit) return explicit.replace(/\/+$/, "");
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/auth/instagram/callback` : "";
}

/** Whether the deployment has enough configuration to attempt the flow at all. */
export function instagramConfigured(): boolean {
  return missingInstagramConfig().length === 0;
}

/**
 * Which pieces of configuration are absent, by name.
 *
 * Names only, never values — same contract as `missingLinkedInConfig`, and for
 * the same reason: this is the message that tells an operator the variables went
 * on the wrong Vercel project, or that the deployment predates them.
 */
export function missingInstagramConfig(): string[] {
  const missing: string[] = [];
  if (!clientId()) missing.push("INSTAGRAM_APP_ID (or META_APP_ID)");
  if (!clientSecret()) missing.push("INSTAGRAM_APP_SECRET (or META_APP_SECRET)");
  if (!instagramRedirectUri()) missing.push("INSTAGRAM_REDIRECT_URI (or PUBLIC_BASE_URL)");
  return missing;
}

/**
 * The URL to send the browser to, with `state` carrying our CSRF proof.
 *
 * The scope separator is a comma, not the space OAuth 2.0 and LinkedIn use.
 * `URLSearchParams` encodes it to `%2C`, which is what the dashboard's own
 * sample consent URL sends.
 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: instagramRedirectUri(),
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Trade an authorization code for a long-lived access token.
 *
 * Two calls, because Instagram splits what LinkedIn does in one. The code
 * exchange returns a token that expires in about an hour — useless for a
 * scheduler that may not run for days — so it is immediately upgraded to the
 * 60-day long-lived token, and only that one is ever stored.
 *
 * Throws a plain `Error` on failure. The caller turns it into a redirect
 * carrying a short reason code; the message names Instagram's own `error_message`
 * but never the response body, which echoes the request on some failures — and
 * the request carried the client secret.
 */
export async function exchangeCodeForToken(code: string): Promise<InstagramToken> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "authorization_code",
    redirect_uri: instagramRedirectUri(),
    // Instagram appends `#_` to the code on the redirect back. It is not part of
    // the credential and the exchange rejects it, so it is stripped here rather
    // than in the route, where it would be one more thing to remember.
    code: code.replace(/#_$/, ""),
  });

  const short = await axios.post(TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
    validateStatus: () => true,
  });

  if (short.status !== 200 || !short.data?.access_token) {
    // Instagram reports failures as `error_type` / `error_message`, and the
    // graph-style ones as a nested `error.message`. Both are diagnostic and
    // safe; the rest of the body is not.
    const detail = [
      short.data?.error_type,
      short.data?.error_message,
      short.data?.error?.message,
    ]
      .filter((v) => typeof v === "string" && v)
      .join(": ");
    throw new Error(
      `instagram token exchange failed (status ${short.status})${detail ? ` — ${detail}` : ""}`,
    );
  }

  // The scopes Instagram actually granted, which need not be what was asked for
  // — a permission declined on the consent screen comes back missing here.
  // Returned as an array, joined to match how the model stores LinkedIn's.
  const granted: string = Array.isArray(short.data.permissions)
    ? short.data.permissions.join(",")
    : String(short.data.permissions ?? INSTAGRAM_SCOPES.join(","));

  const userId = String(short.data.user_id ?? "");
  const long = await exchangeForLongLivedToken(String(short.data.access_token));

  return { ...long, scope: granted, userId };
}

/**
 * Upgrade an hour-long token to the 60-day one.
 *
 * Split out because refreshing an existing connection uses the same endpoint
 * family and the same expiry arithmetic.
 */
async function exchangeForLongLivedToken(
  shortLived: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const { status, data } = await axios.get(`${GRAPH_URL}/access_token`, {
    params: {
      grant_type: "ig_exchange_token",
      client_secret: clientSecret(),
      access_token: shortLived,
    },
    timeout: 10000,
    validateStatus: () => true,
  });

  if (status !== 200 || !data?.access_token) {
    const detail = [data?.error?.message, data?.error_message]
      .filter((v) => typeof v === "string" && v)
      .join(": ");
    throw new Error(
      `instagram long-lived token exchange failed (status ${status})${detail ? ` — ${detail}` : ""}`,
    );
  }

  // Documented as 60 days. The fallback keeps a missing field from producing an
  // Invalid Date, which would read as permanently expired.
  const seconds = Number(data.expires_in) || 60 * 24 * 60 * 60;
  return {
    accessToken: String(data.access_token),
    expiresAt: new Date(Date.now() + seconds * 1000),
  };
}

/**
 * Extend a long-lived token that is still valid.
 *
 * Instagram will only refresh a token that is at least 24 hours old and not yet
 * expired, so this is best-effort by design: it returns `null` when the refresh
 * is refused, and the caller leaves the stored expiry alone rather than treating
 * a declined refresh as a broken connection.
 */
export async function refreshLongLivedToken(
  accessToken: string,
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  try {
    const { status, data } = await axios.get(`${GRAPH_URL}/refresh_access_token`, {
      params: { grant_type: "ig_refresh_token", access_token: accessToken },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (status !== 200 || !data?.access_token) return null;

    const seconds = Number(data.expires_in) || 60 * 24 * 60 * 60;
    return {
      accessToken: String(data.access_token),
      expiresAt: new Date(Date.now() + seconds * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the connected account's profile.
 *
 * `/me` on the Instagram graph host resolves to the token's own account, so
 * there is no id to pass. `user_id` is the app-scoped identifier the publish
 * calls address; `id` is the older per-app one, kept only as a fallback so a
 * connection is never stored without a subject.
 *
 * `profile_picture_url` is requested but not required — a fresh professional
 * account may have no avatar, and that is not a reason to fail a connection.
 */
export async function fetchInstagramProfile(accessToken: string): Promise<InstagramProfile> {
  const { status, data } = await axios.get(`${GRAPH_URL}/v23.0/me`, {
    params: {
      fields: "user_id,username,account_type,profile_picture_url",
      access_token: accessToken,
    },
    timeout: 10000,
    validateStatus: () => true,
  });

  if (status !== 200 || !(data?.user_id || data?.id)) {
    const detail = [data?.error?.message, data?.error_message]
      .filter((v) => typeof v === "string" && v)
      .join(": ");
    throw new Error(
      `instagram profile fetch failed (status ${status})${detail ? ` — ${detail}` : ""}`,
    );
  }

  return {
    userId: String(data.user_id ?? data.id),
    username: String(data.username ?? ""),
    accountType: String(data.account_type ?? ""),
    picture: String(data.profile_picture_url ?? ""),
  };
}
