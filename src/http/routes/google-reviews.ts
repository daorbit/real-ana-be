import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import { GoogleConnection } from "../../modules/reviews/models/GoogleConnection.js";
import { GoogleLocation } from "../../modules/reviews/models/GoogleLocation.js";
import { GoogleReview } from "../../modules/reviews/models/GoogleReview.js";
import {
  GoogleApiError,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  googleBusinessRedirectUri,
  listAccounts,
  listLocations,
  missingGoogleBusinessConfig,
  revokeToken,
} from "../../infra/http-client/google-business.js";
import {
  explainGoogleError,
  syncLocation,
  usableAccessToken,
} from "../../modules/reviews/sync.service.js";
import { verifyGoogleCredential } from "../../infra/http-client/google-auth.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { dashboardCors } from "../middleware/cors.js";
import {
  AuthedRequest,
  blockDemoWrites,
  jwtSecret,
  requireAuth,
} from "../middleware/auth.js";
import { isDenied, resolveAccess } from "../../modules/workspace/access.service.js";
import { badRequest, notFound } from "../../shared/errors/index.js";
import { renderOAuthPopup, studioBase } from "../oauth-popup.js";

 

const router = Router();

// Preflight for the JSON routes below: `DELETE`, and any request carrying an
// `Authorization` header, trigger one before per-route middleware would run.
router.options("*", dashboardCors);

/** Long enough to read a consent screen, short enough that a leaked URL goes stale. */
const STATE_TTL = "10m";

type StatePayload = {
  userId: string;
  workspaceId: string;
  nonce: string;
  kind: "google-business-oauth";
};

/** What went wrong, in words, for the reasons a user can actually act on. */
const REASON_TEXT: Record<string, string> = {
  not_signed_in:
    "Your session could not be verified. Sign in to Quantalog again, then retry connecting Google.",
  not_configured:
    "Google Reviews is not set up on this deployment yet. An administrator needs to add the Google credentials.",
  demo: "Google cannot be connected from a demo session.",
  no_access: "You do not have permission to connect Google for this workspace.",
  invalid_state: "That connection attempt expired. Close this window and start again.",
  missing_code: "Google did not return an authorisation code. Please try again.",
  denied: "You cancelled the Google authorisation.",
  no_refresh_token:
    "Google did not return a refresh token. Remove Quantalog from your Google account permissions and try again.",
  scope_declined:
    "Business Profile access was not granted. The permission is required to read your reviews.",
  google_failed: "Google could not complete the connection. Please try again.",
  save_failed: "The connection could not be saved. Please try again.",
};

function closePopup(
  res: Response,
  status: string,
  detail?: string,
  diagnostic?: string,
): void {
  const ok = status === "connected";
  const params = new URLSearchParams({ google: status });
  if (!ok && detail) params.set("reason", detail);

  renderOAuthPopup(res, {
    source: "quantalog-google-reviews",
    title: "Google Business Profile",
    status,
    reason: detail,
    successTitle: "Google connected",
    failureTitle: "Could not connect Google",
    message: (detail && REASON_TEXT[detail]) || "Something went wrong connecting Google.",
    diagnostic,
    fallbackUrl: `${studioBase()}/?${params.toString()}`,
  });
}

/**
 * Is Google Reviews set up on this deployment?
 *
 * Unauthenticated and open, because it answers a question about the server's
 * own configuration rather than about any user, and the point is to be
 * reachable with curl while diagnosing the failure this integration is most
 * likely to hit. Reports variable *names* only — never a value, not even a
 * partial one.
 */
router.get("/config", (_req: Request, res: Response) => {
  const missing = missingGoogleBusinessConfig();
  res.json({
    configured: missing.length === 0,
    missing,
    // Echoed so a mismatch with the value registered in the Google Cloud
    // console — the other classic failure — is visible without guessing. It is
    // a public URL.
    redirectUri: googleBusinessRedirectUri(),
  });
});

/**
 * Start the flow.
 *
 * Authenticated with the app's JWT in the query string rather than a header,
 * because this endpoint is reached by assigning to `window.location` — a
 * navigation, which cannot carry one. The token travels over TLS, is exchanged
 * immediately for the state token, and the URL it appeared in is replaced by
 * the redirect rather than kept in history.
 *
 * Membership is checked *here*, before Google is ever contacted, and the result
 * is sealed into the signed state. See the note at the top of the file.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const missing = missingGoogleBusinessConfig();
    if (missing.length) {
      // Names, never values. This is the message that tells an operator the
      // variables went on the wrong Vercel project.
      console.error(`[google-reviews] not configured — missing: ${missing.join(", ")}`);
      return closePopup(res, "error", "not_configured");
    }

    const token = String(req.query.token ?? "");
    const workspaceId = String(req.query.workspaceId ?? "");
    if (!token) return closePopup(res, "error", "not_signed_in");
    if (!workspaceId) return closePopup(res, "error", "no_access");

    let userId: string;
    try {
      const payload = jwt.verify(token, jwtSecret()) as { userId: string; demo?: boolean };
      // A demo session is read-only and has no real workspace to attach a
      // connection to, so it is refused here rather than failing at the upsert.
      if (payload.demo) return closePopup(res, "error", "demo");
      userId = payload.userId;
    } catch {
      return closePopup(res, "error", "not_signed_in");
    }

    // Connecting a third-party account is an administrative act, not a
    // viewer's: it spends the workspace's Google quota and exposes the
    // business's review data to everyone in the workspace.
    const access = await resolveAccess({ userId } as AuthedRequest, "admin", workspaceId);
    if (isDenied(access)) return closePopup(res, "error", "no_access");

    const state = jwt.sign(
      {
        userId,
        workspaceId,
        nonce: randomBytes(16).toString("hex"),
        kind: "google-business-oauth",
      } satisfies StatePayload,
      jwtSecret(),
      { expiresIn: STATE_TTL },
    );

    res.redirect(buildAuthorizeUrl(state));
  }),
);

/**
 * The callback Google redirects to.
 *
 * Every failure ends in the popup carrying a short reason code, never a raw
 * Google error: this route renders in the user's address bar, where an API
 * error string is neither useful nor safe.
 *
 * Note what this does *not* do: it does not fetch accounts or locations. Those
 * are separate authenticated calls the dashboard makes afterwards. Doing them
 * here would mean three Google round-trips inside a redirect the browser is
 * waiting on, and any one of them failing would lose a connection that was
 * successfully authorised.
 */
router.get(
  "/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const error = String(req.query.error ?? "");

    // The user pressed Cancel on the consent screen. Not a failure worth a
    // diagnostic — they know what they did.
    if (error) {
      return closePopup(res, "error", error === "access_denied" ? "denied" : "google_failed");
    }

    let payload: StatePayload;
    try {
      const decoded = jwt.verify(state, jwtSecret()) as StatePayload;
      // The `kind` claim stops a token minted for a different flow — a session
      // token, a LinkedIn state — from being replayed here. All are signed with
      // the same secret, so the signature alone does not establish intent.
      if (decoded.kind !== "google-business-oauth") throw new Error("wrong token kind");
      payload = decoded;
    } catch {
      return closePopup(res, "error", "invalid_state");
    }

    if (!code) return closePopup(res, "error", "missing_code");

    // Re-checked rather than trusted from the state: the ten minutes since the
    // flow began is long enough for someone to have been removed from the
    // workspace, and a signed claim records what was true when it was signed.
    const access = await resolveAccess(
      { userId: payload.userId } as AuthedRequest,
      "admin",
      payload.workspaceId,
    );
    if (isDenied(access)) return closePopup(res, "error", "no_access");

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code);
    } catch (err) {
      console.error(
        "[google-reviews] code exchange failed:",
        err instanceof Error ? err.message : err,
      );
      return closePopup(res, "error", "google_failed", explainGoogleError(err));
    }

    // Google grants what the user approved, not what was asked for. Without
    // this scope every later call 403s, and the connection would look healthy
    // right up until the first sync.
    if (tokens.scope && !tokens.scope.includes("business.manage")) {
      await revokeToken(tokens.accessToken);
      return closePopup(res, "error", "scope_declined");
    }

    // No refresh token means the connection dies in an hour and cannot be
    // renewed. `prompt=consent` exists to prevent this; when it happens anyway
    // the honest move is to refuse now rather than ship a connection that
    // breaks silently after lunch.
    if (!tokens.refreshToken) {
      await revokeToken(tokens.accessToken);
      return closePopup(res, "error", "no_refresh_token");
    }

    // Identify the Google account for display. Best effort: the `id_token` is
    // present because `include_granted_scopes` carries the sign-in scopes when
    // the user has them, and a missing profile costs a label, not the flow.
    let googleUserId = "";
    let googleEmail = "";
    if (tokens.idToken) {
      const profile = await verifyGoogleCredential(tokens.idToken);
      if (profile) {
        googleUserId = profile.sub;
        googleEmail = profile.email;
      }
    }

    try {
      await GoogleConnection.findOneAndUpdate(
        { workspaceId: payload.workspaceId },
        {
          workspaceId: payload.workspaceId,
          userId: payload.userId,
          // Falls back to a synthetic marker rather than failing: the id is a
          // display convenience, and the token is what actually matters.
          googleUserId: googleUserId || `google:${payload.workspaceId}`,
          googleEmail,
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
      console.error(
        "[google-reviews] saving connection failed:",
        err instanceof Error ? err.message : err,
      );
      return closePopup(res, "error", "save_failed");
    }

    closePopup(res, "connected");
  }),
);

// ---------------------------------------------------------------------------
// Dashboard API. Everything below is an ordinary authenticated fetch.
// ---------------------------------------------------------------------------

router.use(dashboardCors, requireAuth, blockDemoWrites);

/**
 * The workspace's connection, or a refusal.
 *
 * Every handler below starts here, so membership is proved before a Google
 * connection is so much as looked up — the check that keeps one customer's
 * reviews out of another's workspace.
 */
async function connectionFor(req: AuthedRequest, minimum: "viewer" | "admin" = "viewer") {
  const workspaceId = String(req.params.wid ?? "");
  const access = await resolveAccess(req, minimum, workspaceId);
  if (isDenied(access)) return { denied: access, workspaceId } as const;

  const connection = await GoogleConnection.findOne({ workspaceId });
  return { connection, workspaceId } as const;
}

/**
 * What the dashboard needs to render the module in any of its states.
 *
 * Deliberately projects field by field rather than returning the document:
 * `accessToken` and `refreshToken` are `select: false`, but a future field
 * would not be, and a spread here is how a token eventually reaches a browser.
 */
router.get(
  "/workspaces/:wid/status",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { denied, connection, workspaceId } = await connectionFor(req);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const missing = missingGoogleBusinessConfig();

    if (!connection) {
      return res.json({ configured: missing.length === 0, connected: false, locations: [] });
    }

    const locations = await GoogleLocation.find({ workspaceId }).sort({ createdAt: 1 });

    res.json({
      configured: missing.length === 0,
      connected: true,
      connection: {
        googleEmail: connection.get("googleEmail") ?? "",
        status: connection.get("status"),
        statusMessage: connection.get("statusMessage") ?? "",
        connectedAt: connection.get("createdAt"),
      },
      locations: locations.map((location) => ({
        id: String(location._id),
        title: location.get("title"),
        address: location.get("address"),
        status: location.get("status"),
        averageRating: location.get("averageRating"),
        totalReviewCount: location.get("totalReviewCount"),
        lastSyncedAt: location.get("lastSyncedAt"),
        lastSyncError: location.get("lastSyncError") ?? "",
      })),
    });
  }),
);

/**
 * The businesses this connection can see, for the picker.
 *
 * Read live from Google rather than cached: it is shown once, at the moment of
 * choosing, and a stale list would offer a location the user no longer manages.
 *
 * Accounts and locations come from two different Google APIs, so this walks
 * every account to build one flat list — which is what the picker actually
 * wants, since a user rarely knows or cares which account owns which location.
 */
router.get(
  "/workspaces/:wid/available-locations",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { denied, connection } = await connectionFor(req, "admin");
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (!connection) throw notFound("Google is not connected for this workspace");

    try {
      const accessToken = await usableAccessToken(String(connection._id));
      const accounts = await listAccounts(accessToken);

      if (!accounts.length) {
        return res.json({
          accounts: 0,
          locations: [],
          message:
            "This Google account has no Business Profile. Create one at business.google.com, then reconnect.",
        });
      }

      const locations: Array<{
        googleAccountId: string;
        googleLocationId: string;
        title: string;
        address: string;
      }> = [];

      for (const account of accounts) {
        const accountId = account.name.split("/").pop() ?? account.name;
        for (const location of await listLocations(accessToken, account.name)) {
          locations.push({
            googleAccountId: accountId,
            googleLocationId: location.locationId,
            title: location.title,
            address: location.address,
          });
        }
      }

      res.json({
        accounts: accounts.length,
        locations,
        message: locations.length
          ? undefined
          : "No business locations were found on this Google account.",
      });
    } catch (err) {
      const status = err instanceof GoogleApiError ? err.status : 502;
      res.status(status).json({
        error: explainGoogleError(err),
        kind: err instanceof GoogleApiError ? err.kind : "unknown",
      });
    }
  }),
);

/**
 * Attach a chosen business and pull its reviews straight away.
 *
 * The first sync runs inline rather than being left to the cron: someone who
 * has just connected expects to see reviews, and an empty dashboard with
 * "check back in six hours" reads as a broken integration.
 *
 * A sync failure does not fail the request. The location is saved either way —
 * the choice was valid, and the stored error is what the dashboard shows and
 * the retry button acts on.
 */
router.post(
  "/workspaces/:wid/locations",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { denied, connection, workspaceId } = await connectionFor(req, "admin");
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (!connection) throw notFound("Google is not connected for this workspace");

    const googleAccountId = String(req.body?.googleAccountId ?? "").trim();
    const googleLocationId = String(req.body?.googleLocationId ?? "").trim();
    const title = String(req.body?.title ?? "").trim();
    const address = String(req.body?.address ?? "").trim();

    if (!googleAccountId || !googleLocationId)
      throw badRequest("googleAccountId and googleLocationId are required");

    const location = await GoogleLocation.findOneAndUpdate(
      { workspaceId, googleLocationId },
      {
        workspaceId,
        googleConnectionId: connection._id,
        googleAccountId,
        googleLocationId,
        title,
        address,
        status: "connected",
        lastSyncError: "",
      },
      { upsert: true, new: true },
    );

    let sync = null;
    let syncError: string | undefined;
    try {
      sync = await syncLocation(String(location._id));
    } catch (err) {
      syncError = explainGoogleError(err);
    }

    res.status(201).json({
      location: {
        id: String(location._id),
        title: location.get("title"),
        address: location.get("address"),
        status: location.get("status"),
      },
      sync,
      syncError,
    });
  }),
);

/** Pull one location's reviews now, behind the dashboard's Sync button. */
router.post(
  "/workspaces/:wid/locations/:id/sync",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { denied, workspaceId } = await connectionFor(req, "admin");
    if (denied) return res.status(denied.status).json({ error: denied.error });

    // Scoped by workspace, not just id: an id from another workspace must read
    // as "not found" rather than syncing someone else's business.
    const location = await GoogleLocation.findOne({ _id: req.params.id, workspaceId });
    if (!location) throw notFound("location not found");

    try {
      res.json(await syncLocation(String(location._id)));
    } catch (err) {
      const status = err instanceof GoogleApiError ? err.status : 502;
      res.status(status).json({
        error: explainGoogleError(err),
        kind: err instanceof GoogleApiError ? err.kind : "unknown",
      });
    }
  }),
);

/**
 * The workspace's cached reviews, for the dashboard list.
 *
 * Served from our own collection, never from Google: this is a page someone
 * refreshes, and proxying it would spend the shared quota on every load.
 */
router.get(
  "/workspaces/:wid/reviews",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workspaceId = String(req.params.wid ?? "");
    const access = await resolveAccess(req, "viewer", workspaceId);
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });

    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const filter: Record<string, unknown> = { workspaceId, deletedAt: null };
    if (req.query.locationId) filter.googleLocationId = String(req.query.locationId);

    const reviews = await GoogleReview.find(filter)
      .sort({ reviewCreatedAt: -1 })
      .limit(limit)
      .select("googleReviewId reviewerName reviewerPhoto rating comment reviewCreatedAt replyComment");

    // Counted from the stored rows rather than read off the location, because
    // this histogram describes exactly the reviews being listed — Google's own
    // totals include star-only ratings the reviews endpoint never returns.
    //
    // The ids are cast explicitly: `find` coerces a string to an ObjectId from
    // the schema, but an aggregation pipeline does no such casting and would
    // silently match nothing.
    const breakdown = await GoogleReview.aggregate<{ _id: number; count: number }>([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          deletedAt: null,
          ...(req.query.locationId
            ? { googleLocationId: new mongoose.Types.ObjectId(String(req.query.locationId)) }
            : {}),
        },
      },
      { $group: { _id: "$rating", count: { $sum: 1 } } },
    ]);

    res.json({
      reviews: reviews.map((review) => ({
        id: review.get("googleReviewId"),
        author: review.get("reviewerName"),
        photo: review.get("reviewerPhoto"),
        rating: review.get("rating"),
        comment: review.get("comment"),
        reply: review.get("replyComment") || undefined,
        createdAt: review.get("reviewCreatedAt"),
      })),
      breakdown: [5, 4, 3, 2, 1].map((stars) => ({
        stars,
        count: breakdown.find((entry) => entry._id === stars)?.count ?? 0,
      })),
    });
  }),
);

/**
 * Remove the connection and everything cached under it.
 *
 * The Google grant is revoked first, then the local rows are deleted — a user
 * who disconnects expects Quantalog to stop holding their review data, and
 * leaving it behind so a reconnect is faster is not a trade that is ours to
 * make on their behalf.
 *
 * Revocation is best effort inside `revokeToken`: an unreachable Google must
 * not prevent someone removing a connection.
 */
router.delete(
  "/workspaces/:wid/connection",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { denied, connection, workspaceId } = await connectionFor(req, "admin");
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (!connection) return res.json({ disconnected: true });

    const stored = await GoogleConnection.findById(connection._id).select("+refreshToken");
    const refreshToken = decryptSecret(String(stored?.get("refreshToken") ?? ""));
    // Revoking the refresh token invalidates the whole grant, access token
    // included, so it is the only one worth sending.
    if (refreshToken) await revokeToken(refreshToken);

    await GoogleReview.deleteMany({ workspaceId });
    await GoogleLocation.deleteMany({ workspaceId });
    await GoogleConnection.deleteOne({ _id: connection._id });

    res.json({ disconnected: true });
  }),
);

export default router;
