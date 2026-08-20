import axios from "axios";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * The Turnstile secret. Server-side only — it must never reach the browser, so
 * it is read here and nowhere else, and its value is never logged or returned
 * in a response.
 */
function secret(): string {
  return process.env.CLOUDFLARE_SECRET_KEY ?? "";
}

/**
 * Whether Turnstile is configured on this deployment.
 *
 * Mirrors `googleConfigured`: an environment with no secret set (a local
 * checkout, a test runner) is not forced through a challenge it cannot pass.
 * Callers decide what that means — see the note at the `/login` call site.
 */
export function turnstileConfigured(): boolean {
  return Boolean(secret());
}

/** The outcome of a verification, in the terms the caller has to act on. */
export type TurnstileResult =
  /** Cloudflare said `success: true`. Carry on. */
  | { ok: true }
  /** The token was missing, already spent, expired, or minted for another site. */
  | { ok: false; reason: "invalid" }
  /** Cloudflare could not be reached, or answered with something unusable. */
  | { ok: false; reason: "unavailable" };

/**
 * Verify a Turnstile token with Cloudflare.
 *
 * The two failure reasons are kept apart because they deserve different
 * answers: an invalid token is the client's problem and a 400 is correct, while
 * an unreachable Cloudflare is ours and must not be reported as "you failed the
 * challenge" — the caller maps them accordingly.
 */
export async function verifyTurnstileToken(
  token: unknown,
  remoteIp?: string
): Promise<TurnstileResult> {
  const key = secret();
  if (!key) return { ok: false, reason: "unavailable" };
  // A missing or malformed token never needs a round-trip to be refused.
  if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "invalid" };

  // Cloudflare takes this as form-encoded, not JSON.
  const form = new URLSearchParams({ secret: key, response: token });
  // Optional, and only tightens the check — Cloudflare ignores it when absent.
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const { data } = await axios.post(SITEVERIFY_URL, form, {
      timeout: 8000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // A non-2xx here means the verification could not be completed, which is
      // a service failure rather than a verdict on the token.
      validateStatus: () => true,
    });

    if (!data || typeof data !== "object") return { ok: false, reason: "unavailable" };
    if ((data as { success?: unknown }).success === true) return { ok: true };

    // Anything else is a definite "no" from Cloudflare: expired, already used,
    // wrong sitekey, malformed. The error codes are logged (they never contain
    // the secret) because they are the only way to tell a misconfigured sitekey
    // from ordinary token expiry in production.
    const codes = (data as { "error-codes"?: unknown })["error-codes"];
    // These two say the *secret* is wrong, not the token — failing them as
    // "invalid" would blame every visitor for a deployment mistake.
    const serverFault =
      Array.isArray(codes) &&
      codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret");
    if (serverFault) {
      console.error("[turnstile] secret rejected by Cloudflare — check CLOUDFLARE_SECRET_KEY");
      return { ok: false, reason: "unavailable" };
    }
    return { ok: false, reason: "invalid" };
  } catch (e) {
    console.error("[turnstile] verification failed:", e instanceof Error ? e.message : e);
    return { ok: false, reason: "unavailable" };
  }
}
