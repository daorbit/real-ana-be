import axios from "axios";


const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

export type GoogleProfile = {
  /** Google's stable subject id — the only durable identifier for the account. */
  sub: string;
  email: string;
  name: string;
  picture: string;
};

/** The client id the frontend signs in with. Tokens minted for anyone else are refused. */
function expectedAudience(): string {
  return process.env.GOOGLE_CLIENT_ID ?? "";
}

export function googleConfigured(): boolean {
  return Boolean(expectedAudience());
}

/**
 * Verify a Google ID token and return the profile it attests to.
 *
 * Returns `null` for anything that fails a check, deliberately without saying
 * which one — the caller has no useful distinction to draw, and the detail
 * would only help someone probing the endpoint.
 */
export async function verifyGoogleCredential(
  credential: string
): Promise<GoogleProfile | null> {
  const aud = expectedAudience();
  if (!aud || !credential) return null;

  try {
    const { data } = await axios.get(TOKENINFO_URL, {
      params: { id_token: credential },
      timeout: 8000,
      // A non-2xx from tokeninfo means "not a valid token", which is a normal
      // outcome here rather than an exception to log.
      validateStatus: () => true,
    });

    if (!data || typeof data !== "object") return null;

    const payload = data as Record<string, string>;

    // The token must have been issued for this application. Without this check
    // any Google ID token from any app would be accepted as a login here.
    if (payload.aud !== aud) return null;

    // Google's own issuer, spelled either way.
    if (
      payload.iss !== "https://accounts.google.com" &&
      payload.iss !== "accounts.google.com"
    )
      return null;

    // tokeninfo rejects expired tokens, but the claim is checked anyway so a
    // change at the far end can't quietly widen what is accepted.
    const exp = Number(payload.exp ?? 0);
    if (!exp || exp * 1000 <= Date.now()) return null;

    // An unverified address is not proof of ownership: it must not be allowed
    // to claim an existing account that signed up with the same email.
    if (String(payload.email_verified) !== "true") return null;

    const email = String(payload.email ?? "").toLowerCase().trim();
    const sub = String(payload.sub ?? "");
    if (!email || !sub) return null;

    return {
      sub,
      email,
      name: String(payload.name ?? "").trim() || email.split("@")[0],
      picture: String(payload.picture ?? ""),
    };
  } catch (e) {
    console.error("[google-auth] verification failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
