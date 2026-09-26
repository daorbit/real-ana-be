import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { SearchConsoleConnection } from "../../modules/seo/models/SearchConsoleConnection.js";
import {
  buildSearchConsoleAuthorizeUrl,
  exchangeSearchConsoleCode,
  fetchGoogleProfile,
  hasSearchConsoleScope,
  missingSearchConsoleConfig,
  revokeSearchConsoleToken,
  searchConsoleRedirectUri,
} from "../../infra/http-client/search-console.js";
import { explainSearchConsoleError } from "../../modules/seo/search-console.service.js";
import { currentPlan } from "../../modules/billing/quota.service.js";
import { encryptSecret } from "../../shared/utils/crypto-box.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { AuthedRequest, jwtSecret } from "../middleware/auth.js";
import { isDenied, resolveAccess } from "../../modules/workspace/access.service.js";
import { renderOAuthPopup, studioBase } from "../oauth-popup.js";

const router = Router();

const STATE_TTL = "10m";
const STATE_KIND = "search-console-oauth";

type StatePayload = {
  userId: string;
  workspaceId: string;
  nonce: string;
  kind: typeof STATE_KIND;
};

const REASON_TEXT: Record<string, string> = {
  not_signed_in: "Your session could not be verified. Sign in to Quantalog again, then retry.",
  not_configured:
    "Search Console is not set up on this deployment yet. An administrator needs to add the Google credentials.",
  demo: "Search Console cannot be connected from a demo session.",
  no_access: "You need admin access to this workspace to connect Search Console.",
  plan_required: "Search Console needs this workspace on a paid plan.",
  invalid_state: "That connection attempt expired. Close this window and start again.",
  missing_code: "Google did not return an authorisation code. Please try again.",
  denied: "You cancelled the Google authorisation.",
  no_refresh_token:
    "Google did not return a refresh token. Remove Quantalog from your Google account permissions and try again.",
  scope_declined:
    "Search Console access was not granted. Tick the Search Console permission on Google's consent screen.",
  google_failed: "Google could not complete the connection. Please try again.",
  save_failed: "The connection could not be saved. Please try again.",
};

function closePopup(res: Response, status: string, reason?: string, diagnostic?: string): void {
  const params = new URLSearchParams({ searchConsole: status });
  if (status !== "connected" && reason) params.set("reason", reason);

  renderOAuthPopup(res, {
    source: "quantalog-search-console",
    title: "Google Search Console",
    status,
    reason,
    successTitle: "Search Console connected",
    failureTitle: "Could not connect Search Console",
    message: (reason && REASON_TEXT[reason]) || "Something went wrong connecting Search Console.",
    diagnostic,
    fallbackUrl: `${studioBase()}/app/search-visibility?${params.toString()}`,
  });
}

async function onPaidPlan(workspaceId: string): Promise<boolean> {
  const plan = await currentPlan(workspaceId);
  return Boolean(plan && plan.slug !== "free");
}

router.get("/config", (_req: Request, res: Response) => {
  const missing = missingSearchConsoleConfig();
  res.json({ configured: missing.length === 0, missing, redirectUri: searchConsoleRedirectUri() });
});

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const missing = missingSearchConsoleConfig();
    if (missing.length) {
      console.error(`[search-console] not configured — missing: ${missing.join(", ")}`);
      return closePopup(res, "error", "not_configured");
    }

    const token = String(req.query.token ?? "");
    const workspaceId = String(req.query.workspaceId ?? "");
    if (!token) return closePopup(res, "error", "not_signed_in");
    if (!workspaceId) return closePopup(res, "error", "no_access");

    let userId: string;
    try {
      const payload = jwt.verify(token, jwtSecret()) as { userId: string; demo?: boolean };
      if (payload.demo) return closePopup(res, "error", "demo");
      userId = payload.userId;
    } catch {
      return closePopup(res, "error", "not_signed_in");
    }

    const access = await resolveAccess({ userId } as AuthedRequest, "admin", workspaceId);
    if (isDenied(access)) return closePopup(res, "error", "no_access");
    if (!(await onPaidPlan(workspaceId))) return closePopup(res, "error", "plan_required");

    const state = jwt.sign(
      { userId, workspaceId, nonce: randomBytes(16).toString("hex"), kind: STATE_KIND } satisfies StatePayload,
      jwtSecret(),
      { expiresIn: STATE_TTL },
    );

    res.redirect(buildSearchConsoleAuthorizeUrl(state));
  }),
);

router.get(
  "/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const error = String(req.query.error ?? "");

    if (error) return closePopup(res, "error", error === "access_denied" ? "denied" : "google_failed");

    let payload: StatePayload;
    try {
      const decoded = jwt.verify(state, jwtSecret()) as StatePayload;
      if (decoded.kind !== STATE_KIND) throw new Error("wrong token kind");
      payload = decoded;
    } catch {
      return closePopup(res, "error", "invalid_state");
    }

    if (!code) return closePopup(res, "error", "missing_code");

    const access = await resolveAccess(
      { userId: payload.userId } as AuthedRequest,
      "admin",
      payload.workspaceId,
    );
    if (isDenied(access)) return closePopup(res, "error", "no_access");

    let tokens;
    try {
      tokens = await exchangeSearchConsoleCode(code);
    } catch (err) {
      console.error("[search-console] code exchange failed:", err instanceof Error ? err.message : err);
      return closePopup(res, "error", "google_failed", explainSearchConsoleError(err));
    }

    if (tokens.scope && !hasSearchConsoleScope(tokens.scope)) {
      await revokeSearchConsoleToken(tokens.accessToken);
      return closePopup(res, "error", "scope_declined");
    }

    if (!tokens.refreshToken) {
      await revokeSearchConsoleToken(tokens.accessToken);
      return closePopup(res, "error", "no_refresh_token");
    }

    const profile = await fetchGoogleProfile(tokens.accessToken);

    try {
      await SearchConsoleConnection.findOneAndUpdate(
        { workspaceId: payload.workspaceId },
        {
          workspaceId: payload.workspaceId,
          userId: payload.userId,
          googleUserId: profile?.sub ?? "",
          googleEmail: profile?.email ?? "",
          accessToken: encryptSecret(tokens.accessToken),
          refreshToken: encryptSecret(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
          status: "active",
          statusMessage: "",
        },
        { upsert: true, new: true },
      );
    } catch (err) {
      console.error("[search-console] saving connection failed:", err instanceof Error ? err.message : err);
      return closePopup(res, "error", "save_failed");
    }

    closePopup(res, "connected");
  }),
);

export default router;
