import express, { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware/async-handler.js";
import { limitByIp } from "../middleware/mcp-guards.js";
import { markServerErrorReported } from "../middleware/report-server-errors.js";
import { registerClient } from "../../modules/mcp-oauth/client.service.js";
import { AuthorizeRedirect, UnredirectableError, startAuthorization } from "../../modules/mcp-oauth/authorize.service.js";
import { exchangeAuthorizationCode, refreshAccessToken, revokeToken } from "../../modules/mcp-oauth/token.service.js";
import { isOAuthError, OAuthError } from "../../modules/mcp-oauth/errors.js";
import { renderOAuthErrorPage } from "../views/oauth-error-page.js";
import { captureServerError } from "../../infra/monitoring/sentry.js";
import { runAfterResponse } from "../../shared/utils/after-response.js";

const MINUTE = 60_000;
const router = Router();

router.use(express.urlencoded({ extended: false, limit: "16kb" }));

function noStore(res: Response) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

async function sendOAuthFailure(req: Request, res: Response, err: unknown) {
  noStore(res);
  if (isOAuthError(err)) return res.status(err.status).json(err.toJSON());
  markServerErrorReported(res);
  res.status(500).json({ error: "server_error", error_description: "unexpected error" });
  runAfterResponse("oauth error report", () => captureServerError(err, { method: req.method, path: req.path }));
}

router.post(
  "/register",
  limitByIp("oauth-register", 20, 60 * MINUTE),
  asyncHandler(async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const client = await registerClient(body);
      noStore(res);
      res.status(201).json(client);
    } catch (err) {
      await sendOAuthFailure(req, res, err);
    }
  }),
);

router.get(
  "/authorize",
  limitByIp("oauth-authorize", 60, MINUTE),
  asyncHandler(async (req, res) => {
    try {
      res.redirect(302, await startAuthorization(req.query as Record<string, unknown>));
    } catch (err) {
      if (err instanceof AuthorizeRedirect) return res.redirect(302, err.location);
      if (err instanceof UnredirectableError) {
        return res.status(400).type("html").send(renderOAuthErrorPage(err.message));
      }
      markServerErrorReported(res);
      res.status(500).type("html").send(renderOAuthErrorPage("Something went wrong. Try connecting again."));
      runAfterResponse("oauth error report", () => captureServerError(err, { method: req.method, path: req.path }));
    }
  }),
);

router.post(
  "/token",
  limitByIp("oauth-token", 60, MINUTE),
  asyncHandler(async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = body.grant_type;
      const tokens =
        grantType === "authorization_code"
          ? await exchangeAuthorizationCode(body)
          : grantType === "refresh_token"
            ? await refreshAccessToken(body)
            : null;
      if (!tokens) throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
      noStore(res);
      res.json(tokens);
    } catch (err) {
      await sendOAuthFailure(req, res, err);
    }
  }),
);

router.post(
  "/revoke",
  limitByIp("oauth-revoke", 60, MINUTE),
  asyncHandler(async (req, res) => {
    try {
      await revokeToken((req.body ?? {}) as Record<string, unknown>);
      noStore(res);
      res.status(200).end();
    } catch (err) {
      await sendOAuthFailure(req, res, err);
    }
  }),
);

export default router;
