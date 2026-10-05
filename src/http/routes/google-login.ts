import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from "../../infra/http-client/google-oauth.js";
import {
  GOOGLE_LOGIN_AUTHORIZE_OVERRIDES,
  GOOGLE_LOGIN_SCOPE,
  googleLoginConfig,
  googleLoginRedirectUri,
  missingGoogleLoginConfig,
} from "../../infra/http-client/google-login-config.js";
import { verifyGoogleCredential, type GoogleProfile } from "../../infra/http-client/google-auth.js";
import { resolveGoogleUser } from "../../modules/identity/google-login.service.js";
import { safeEqual } from "../../shared/utils/crypto-box.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { signToken, signPending2faToken, jwtSecret } from "../middleware/auth.js";
import { studioBase } from "../oauth-popup.js";

const router = Router();

const STATE_TTL = "10m";
const STATE_KIND = "google-oauth";

type StatePayload = { nonce: string; kind: typeof STATE_KIND };

function loginUrl(status: string, extra: { reason?: string; token?: string; pendingToken?: string } = {}): string {
  const params = new URLSearchParams({ googleLogin: status });
  if (extra.reason) params.set("reason", extra.reason);
  if (extra.token) params.set("token", extra.token);
  if (extra.pendingToken) params.set("pendingToken", extra.pendingToken);
  return `${studioBase()}/login?${params.toString()}`;
}

export function isGoogleLoginState(state: string): boolean {
  try {
    const payload = jwt.verify(state, jwtSecret()) as StatePayload;
    return safeEqual(payload.kind ?? "", STATE_KIND);
  } catch {
    return false;
  }
}

export async function handleGoogleLoginCallback(req: Request, res: Response): Promise<void> {
  if (req.query.error) {
    const cancelled = req.query.error === "access_denied";
    return res.redirect(loginUrl(cancelled ? "cancelled" : "error", { reason: "denied" }));
  }

  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code) return res.redirect(loginUrl("error", { reason: "missing_code" }));
  if (!isGoogleLoginState(state)) return res.redirect(loginUrl("error", { reason: "invalid_state" }));

  const config = googleLoginConfig();
  let profile: GoogleProfile | null;
  try {
    const { idToken } = await exchangeGoogleCode(config, code);
    profile = idToken ? await verifyGoogleCredential(idToken, config.clientId) : null;
  } catch (e) {
    console.error("[google] sign-in failed:", e instanceof Error ? e.message : e);
    return res.redirect(loginUrl("error", { reason: "google_failed" }));
  }
  if (!profile) return res.redirect(loginUrl("error", { reason: "no_email" }));

  try {
    const { user, created } = await resolveGoogleUser(profile);
    if (user.totpEnabled) {
      return res.redirect(loginUrl("2fa", { pendingToken: signPending2faToken(user.id) }));
    }
    return res.redirect(loginUrl(created ? "created" : "ok", { token: await signToken(user.id, req) }));
  } catch (e) {
    console.error("[google] login failed:", e instanceof Error ? e.message : e);
    return res.redirect(loginUrl("error", { reason: "login_failed" }));
  }
}

router.get("/config", (_req: Request, res: Response) => {
  const missing = missingGoogleLoginConfig();
  res.json({ configured: missing.length === 0, missing, redirectUri: googleLoginRedirectUri() });
});

router.get("/", (_req: Request, res: Response) => {
  const missing = missingGoogleLoginConfig();
  if (missing.length) {
    console.error(`[google] redirect sign-in not configured — missing: ${missing.join(", ")}`);
    return res.redirect(`${studioBase()}/signup`);
  }

  const state = jwt.sign(
    { nonce: randomBytes(16).toString("hex"), kind: STATE_KIND } satisfies StatePayload,
    jwtSecret(),
    { expiresIn: STATE_TTL },
  );

  res.redirect(
    buildGoogleAuthorizeUrl(googleLoginConfig(), GOOGLE_LOGIN_SCOPE, state, GOOGLE_LOGIN_AUTHORIZE_OVERRIDES),
  );
});

router.get("/callback", asyncHandler(handleGoogleLoginCallback));

export default router;
