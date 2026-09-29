import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { User } from "../../modules/identity/models/User.js";
import { mailConfigured, sendWelcomeEmail } from "../../infra/mail/mailer.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchGitHubProfile,
  gitHubRedirectUri,
  missingGitHubConfig,
  type GitHubProfile,
} from "../../infra/http-client/github-auth.js";
import { safeEqual } from "../../shared/utils/crypto-box.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { signToken, signPending2faToken, jwtSecret } from "../middleware/auth.js";
import { studioBase } from "../oauth-popup.js";

const router = Router();

const STATE_TTL = "10m";
const STATE_KIND = "github-oauth";

type StatePayload = { nonce: string; kind: typeof STATE_KIND };

function loginUrl(status: string, extra: { reason?: string; token?: string; pendingToken?: string } = {}): string {
  const params = new URLSearchParams({ githubLogin: status });
  if (extra.reason) params.set("reason", extra.reason);
  if (extra.token) params.set("token", extra.token);
  if (extra.pendingToken) params.set("pendingToken", extra.pendingToken);
  return `${studioBase()}/login?${params.toString()}`;
}

async function resolveLoginUser(profile: GitHubProfile) {
  const bySub = await User.findOne({ githubId: profile.sub });
  if (bySub) return { user: bySub, created: false };

  if (!profile.email) throw new Error("github returned no verified email to sign in with");

  const existing = await User.findOne({ email: profile.email });
  if (existing) {
    existing.githubId = profile.sub;
    if (!existing.avatarUrl) existing.avatarUrl = profile.picture;
    await existing.save();
    return { user: existing, created: false };
  }

  const [first, ...rest] = profile.name.split(" ");
  const user = await User.create({
    email: profile.email,
    name: profile.name || profile.email.split("@")[0],
    firstName: first ?? "",
    lastName: rest.join(" "),
    githubId: profile.sub,
    avatarUrl: profile.picture,
  });

  if (mailConfigured()) {
    void sendWelcomeEmail({ email: user.email, name: user.name }).catch((e: unknown) => {
      console.error("[github] welcome email failed:", e instanceof Error ? e.message : e);
    });
  }

  return { user, created: true };
}

router.get("/config", (_req: Request, res: Response) => {
  const missing = missingGitHubConfig();
  res.json({ configured: missing.length === 0, missing, redirectUri: gitHubRedirectUri() });
});

router.get("/", (_req: Request, res: Response) => {
  const missing = missingGitHubConfig();
  if (missing.length) {
    console.error(`[github] not configured — missing: ${missing.join(", ")}`);
    return res.redirect(loginUrl("error", { reason: "not_configured" }));
  }

  const state = jwt.sign(
    { nonce: randomBytes(16).toString("hex"), kind: STATE_KIND } satisfies StatePayload,
    jwtSecret(),
    { expiresIn: STATE_TTL },
  );

  res.redirect(buildGitHubAuthorizeUrl(state));
});

router.get(
  "/callback",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.query.error) {
      const cancelled = req.query.error === "access_denied";
      return res.redirect(loginUrl(cancelled ? "cancelled" : "error", { reason: "denied" }));
    }

    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code) return res.redirect(loginUrl("error", { reason: "missing_code" }));

    try {
      const payload = jwt.verify(state, jwtSecret()) as StatePayload;
      if (!safeEqual(payload.kind ?? "", STATE_KIND)) throw new Error("wrong kind");
    } catch {
      return res.redirect(loginUrl("error", { reason: "invalid_state" }));
    }

    let profile: GitHubProfile;
    try {
      const accessToken = await exchangeGitHubCode(code);
      profile = await fetchGitHubProfile(accessToken);
    } catch (e) {
      console.error("[github] sign-in failed:", e instanceof Error ? e.message : e);
      return res.redirect(loginUrl("error", { reason: "github_failed" }));
    }

    try {
      const { user, created } = await resolveLoginUser(profile);
      if (user.totpEnabled) {
        return res.redirect(loginUrl("2fa", { pendingToken: signPending2faToken(user.id) }));
      }
      return res.redirect(loginUrl(created ? "created" : "ok", { token: signToken(user.id) }));
    } catch (e) {
      console.error("[github] login failed:", e instanceof Error ? e.message : e);
      const reason = profile.email ? "login_failed" : "no_email";
      return res.redirect(loginUrl("error", { reason }));
    }
  }),
);

export default router;
