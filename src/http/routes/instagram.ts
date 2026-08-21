import express, { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { createHmac, randomBytes } from "node:crypto";
import { SocialConnection } from "../../modules/identity/models/SocialConnection.js";
import { ScheduledPost } from "../../modules/social/models/ScheduledPost.js";
import {
  buildAuthorizeUrl,
  canPublish,
  exchangeCodeForToken,
  fetchInstagramProfile,
  instagramRedirectUri,
  missingInstagramConfig,
} from "../../infra/http-client/instagram-auth.js";
import { encryptSecret, safeEqual } from "../../shared/utils/crypto-box.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { dashboardCors } from "../middleware/cors.js";
import { requireAuth, blockDemoWrites, jwtSecret, AuthedRequest } from "../middleware/auth.js";

/**
 * Connecting an Instagram professional account.
 *
 * Mounted at `/api/auth/instagram`, and aliased at the bare `/auth/instagram`
 * — see `app.ts`. The alias is not a convenience: the callback, deauthorize and
 * data-deletion URLs registered in the Meta dashboard have no `/api` prefix, and
 * Meta matches the redirect URI as a string.
 *
 * Written alongside `linkedin.ts` and deliberately shaped like it: the same JWT
 * state, the same popup that reports its outcome to the opener, the same "every
 * failure ends in a short reason code, never a raw API error" rule. Read that
 * file's header for why the state carries the user's identity — this app keeps
 * no server-side session, and an OAuth redirect carries no `Authorization`
 * header, so the signed state is the only thing tying the callback to a user.
 *
 * One thing it does not have: a login mode. Instagram Login returns no email
 * address — `instagram_business_basic` does not carry one — and an account here
 * is keyed by address, so there would be nothing to find or create a user from.
 * Instagram is a connection only.
 */

const router = Router();

// Preflight for the JSON routes below. `DELETE`, and a `GET` carrying an
// `Authorization` header, both trigger one before any per-route middleware runs.
router.options("*", dashboardCors);

/** Long enough to read a consent screen, short enough that a leaked URL goes stale. */
const STATE_TTL = "10m";

type StatePayload = {
  userId: string;
  nonce: string;
  kind: "instagram-oauth";
};

/**
 * Where the browser is sent once the flow finishes.
 *
 * Read from configuration rather than from the request — an open redirect that
 * takes its destination from a query parameter is exactly the bug OAuth
 * callbacks are known for.
 */
function studioBase(): string {
  return (process.env.STUDIO_BASE_URL ?? "https://studio-quantalog.daorbit.in").replace(/\/+$/, "");
}

function studioUrl(status: string, detail?: string): string {
  const params = new URLSearchParams({ instagram: status });
  if (detail) params.set("reason", detail);
  return `${studioBase()}/settings?${params.toString()}`;
}

/** What went wrong, in words, for the few reasons a user can act on. */
const REASON_TEXT: Record<string, string> = {
  not_signed_in:
    "Your session could not be verified. Sign in to Quantalog again, then retry connecting Instagram.",
  not_configured:
    "Instagram is not set up on this deployment yet. An administrator needs to add the Instagram credentials.",
  demo: "Instagram cannot be connected from a demo session.",
  invalid_state: "That connection attempt expired. Close this window and start again.",
  missing_code: "Instagram did not return an authorisation code. Please try again.",
  instagram_failed: "Instagram could not complete the connection. Please try again.",
  save_failed: "The connection could not be saved. Please try again.",
  denied: "You cancelled the Instagram authorisation.",
  no_publish:
    "Posting permission was not granted. Reconnect and allow Quantalog to publish to continue.",
  already_connected:
    "That Instagram account is already connected to a different Quantalog account.",
  not_professional:
    "Only Instagram Business or Creator accounts can be connected. Switch your account type in the Instagram app, then try again.",
};

/**
 * End the flow from inside the popup, without loading the studio into it.
 *
 * Same reasoning as the LinkedIn version: the popup is a disposable window, and
 * redirecting it to the studio renders a second full copy of the application
 * just to read one query parameter. The fallback matters as much as the happy
 * path — with no opener the flow ran as a full-page navigation, and the only
 * sensible destination is back into the app.
 */
function closePopup(
  res: Response,
  status: string,
  detail?: string,
  /**
   * Our own diagnostic text, shown in small print under the message.
   *
   * Only ever a message this server wrote — never an Instagram response body, a
   * token, or a secret. The person who sees this page cannot read the server
   * log, and "please try again" alone costs rounds of guessing.
   */
  diagnostic?: string,
): void {
  const ok = status === "connected";
  const target = ok ? studioUrl(status) : studioUrl(status, detail);
  const message = (detail && REASON_TEXT[detail]) || "Something went wrong connecting Instagram.";

  res
    .type("html")
    .send(`<!doctype html>
<meta charset="utf-8">
<title>Instagram</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<body style="margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;
             display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1c1e21">
  <div style="max-width:340px;padding:28px;text-align:center">
    ${ok
      ? `<p style="font-size:15px;font-weight:600;margin:0">Instagram connected</p>
         <p style="color:#65676b;margin:8px 0 0">You can close this window.</p>`
      : `<p style="font-size:15px;font-weight:600;margin:0">Could not connect Instagram</p>
         <p style="color:#65676b;margin:8px 0 16px">${escapeHtml(message)}</p>
         ${diagnostic
           ? `<p style="color:#8a8d91;font-size:12px;margin:0 0 16px;word-break:break-word">
                ${escapeHtml(diagnostic)}
              </p>`
           : ""}
         <button onclick="window.close()"
           style="border:1px solid #ccd0d5;background:#fff;border-radius:6px;
                  padding:7px 16px;font:inherit;cursor:pointer">Close</button>`}
  </div>
</body>
<script>
  (function () {
    var msg = {
      source: "quantalog-instagram",
      status: ${JSON.stringify(status)},
      reason: ${JSON.stringify(detail ?? "")}
    };
    if (window.opener && window.opener !== window) {
      // The opener validates the origin, so it is named explicitly here.
      window.opener.postMessage(msg, ${JSON.stringify(studioBase())});
      // Only a success closes itself. A failure stays on screen with the reason:
      // a window that opens and vanishes tells the user nothing.
      if (${JSON.stringify(ok)}) window.close();
    } else {
      window.location.replace(${JSON.stringify(target)});
    }
  })();
</script>`);
}

/** Escape text interpolated into the page above. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Is Instagram set up on this deployment?
 *
 * Unauthenticated and open, matching `/api/auth/linkedin/config`: it answers a
 * question about the server's own configuration rather than about any user, and
 * being reachable with curl is the point while diagnosing the failure this
 * integration is most likely to hit. Variable *names* only — never a value.
 */
router.get("/config", (_req: Request, res: Response) => {
  const missing = missingInstagramConfig();
  res.json({
    configured: missing.length === 0,
    missing,
    // Echoed so a mismatch with the value registered in the Meta dashboard —
    // the other classic failure — is visible without guessing. It is public.
    redirectUri: instagramRedirectUri(),
  });
});

/**
 * Start the flow.
 *
 * Authenticated with the app's JWT in the query string rather than a header,
 * because this endpoint is reached by assigning to `window.location` — a
 * navigation, which cannot carry one. The token travels over TLS, is exchanged
 * immediately for the state token, and the URL it appeared in is replaced by
 * the redirect rather than kept.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const missing = missingInstagramConfig();
    if (missing.length) {
      // Names, never values. This is the line that tells an operator the
      // variables went on the wrong Vercel project.
      console.error(`[instagram] not configured — missing: ${missing.join(", ")}`);
      return closePopup(res, "error", "not_configured");
    }

    const token = String(req.query.token ?? "");
    if (!token) return closePopup(res, "error", "not_signed_in");

    let userId: string;
    try {
      const payload = jwt.verify(token, jwtSecret()) as { userId: string; demo?: boolean };
      // A demo session is read-only and has no real user row to attach a
      // connection to, so it is refused here rather than failing at the upsert.
      if (payload.demo) return closePopup(res, "error", "demo");
      userId = payload.userId;
    } catch {
      return closePopup(res, "error", "not_signed_in");
    }

    const state = jwt.sign(
      {
        userId,
        nonce: randomBytes(16).toString("hex"),
        kind: "instagram-oauth",
      } satisfies StatePayload,
      jwtSecret(),
      { expiresIn: STATE_TTL },
    );

    res.redirect(buildAuthorizeUrl(state));
  }),
);

/**
 * The callback Instagram redirects to.
 *
 * Every failure path ends in the popup carrying a short reason code, never a
 * raw Instagram error: this route renders in the user's address bar, and an API
 * error string is neither useful nor safe there.
 */
router.get(
  "/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");

    // The user pressed Cancel on the consent screen. A normal outcome, not an
    // error worth logging.
    if (req.query.error) {
      const denied = req.query.error === "access_denied";
      return closePopup(res, denied ? "cancelled" : "error", "denied");
    }

    if (!code) return closePopup(res, "error", "missing_code");
    if (!state) return closePopup(res, "error", "invalid_state");

    let userId: string;
    try {
      const payload = jwt.verify(state, jwtSecret()) as StatePayload;
      // The `kind` claim stops any other token this app signs — a login token
      // above all — from being replayed here as state.
      if (!safeEqual(payload.kind ?? "", "instagram-oauth")) throw new Error("wrong kind");
      if (!payload.userId) throw new Error("missing user");
      userId = payload.userId;
    } catch {
      return closePopup(res, "error", "invalid_state");
    }

    let token;
    let profile;
    try {
      token = await exchangeCodeForToken(code);
      profile = await fetchInstagramProfile(token.accessToken);
    } catch (e) {
      // Safe to log and to show: the client builds these messages from a status
      // code and Meta's own error fields, never from the response body.
      const why = e instanceof Error ? e.message : String(e);
      console.error("[instagram] connect failed:", why);
      return closePopup(res, "error", "instagram_failed", why);
    }

    // What Instagram granted, which is not always what was asked for — the
    // consent screen lets someone approve the basic read and decline publishing.
    // Refused here rather than at publish time, where it would look like a
    // broken integration weeks after the connection was made.
    if (!canPublish(token.scope)) {
      console.warn(`[instagram] publishing not granted; scopes: ${token.scope || "(none reported)"}`);
      return closePopup(res, "error", "no_publish");
    }

    // A personal account cannot use the publishing API at all. Instagram reports
    // the type here, so the connection is refused now with an instruction the
    // user can act on, rather than at the first scheduled post.
    if (profile.accountType && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(profile.accountType)) {
      return closePopup(res, "error", "not_professional");
    }

    // The same Instagram account connected to a second Quantalog user would give
    // two accounts a token for one feed, and a disconnect from either would read
    // as broken to the other. Refused rather than silently stolen.
    const takenByOther = await SocialConnection.findOne({
      provider: "instagram",
      providerUserId: profile.userId,
      userId: { $ne: userId },
    }).select("_id");

    if (takenByOther) return closePopup(res, "error", "already_connected");

    try {
      // Upsert on (userId, provider), the collection's unique key: connecting a
      // second time replaces the token and refreshes the profile instead of
      // leaving a duplicate row behind.
      await SocialConnection.findOneAndUpdate(
        { userId, provider: "instagram" },
        {
          $set: {
            providerUserId: profile.userId,
            // The `@username`, which is the only display identity Instagram
            // gives. No email: the scope does not carry one.
            name: profile.username,
            picture: profile.picture,
            accessToken: encryptSecret(token.accessToken),
            expiresAt: token.expiresAt,
            scope: token.scope,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (e) {
      // Logged with the error's name and any Mongo driver code alongside the
      // message: every cause — a failed connection, a duplicate key, a
      // validation error, a missing encryption key — otherwise reads identically
      // on a server whose only witness is the log.
      const err = e as { name?: string; message?: string; code?: unknown; codeName?: string };
      const detail = [
        err?.name,
        err?.message,
        err?.code !== undefined ? `code=${String(err.code)}` : "",
        err?.codeName,
      ]
        .filter(Boolean)
        .join(" | ");

      console.error("[instagram] could not save connection:", detail);
      return closePopup(res, "error", "save_failed", detail);
    }

    closePopup(res, "connected");
  }),
);

/**
 * Whether the current user has Instagram connected, and as whom.
 *
 * Returns a hand-picked profile subset. The token is `select: false` on the
 * model and is not asked for here, so it cannot reach this response even by
 * mistake.
 */
router.get(
  "/status",
  dashboardCors,
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const conn = await SocialConnection.findOne({
      userId: req.userId,
      provider: "instagram",
    }).select("name picture expiresAt scope");

    // Whether the deployment can run the flow at all. Reported so the panel can
    // say "not configured" in place of a button, rather than opening a popup
    // that only bounces straight back.
    const missing = missingInstagramConfig();
    const configured = missing.length === 0;

    if (!conn) {
      // Absent variable names are safe to return and save an operator a trip
      // through the logs. Nothing is returned once the deployment is configured.
      return res.json({ connected: false, configured, ...(configured ? {} : { missing }) });
    }

    // Reported rather than hidden, so the panel can offer "Reconnect" before the
    // user writes a caption and discovers the problem at publish time.
    const expired = conn.expiresAt.getTime() <= Date.now();

    res.json({
      connected: true,
      configured,
      expired,
      canPublish: canPublish(conn.scope),
      profile: {
        // The `@username`. No email — see the model.
        username: conn.name,
        picture: conn.picture,
      },
    });
  }),
);

/**
 * Disconnect.
 *
 * Instagram has no token revocation endpoint of the kind LinkedIn offers — a
 * user revokes access from the Instagram app itself — so this deletes the local
 * row, which is what stops this app using the token. Any schedule pointing at
 * Instagram is paused rather than left to fail every tick with a connection
 * error it cannot resolve on its own.
 */
router.delete(
  "/",
  dashboardCors,
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const removed = await SocialConnection.findOneAndDelete({
      userId: req.userId,
      provider: "instagram",
    });

    if (removed) await pauseInstagramSchedules(req.userId!);

    res.json({ connected: false });
  }),
);

/**
 * Stop this user's Instagram schedules from running without a connection.
 *
 * Paused rather than deleted: the user wrote that content, and disconnecting an
 * account is not a request to throw it away. Reconnecting and un-pausing brings
 * it straight back.
 */
async function pauseInstagramSchedules(userId: string): Promise<void> {
  try {
    await ScheduledPost.updateMany(
      { userId, provider: "instagram", status: "active" },
      { $set: { status: "paused", lastError: "Instagram was disconnected." } },
    );
  } catch (e) {
    console.error("[instagram] could not pause schedules:", (e as Error).message);
  }
}

/**
 * Meta's signed request, as sent to the deauthorize and data-deletion callbacks.
 *
 * `<base64url signature>.<base64url payload>`, where the signature is an
 * HMAC-SHA256 of the *encoded payload string* under the app secret. Verifying it
 * is the whole security of these two endpoints: they are unauthenticated POSTs
 * from Meta's infrastructure carrying nothing but this, so an unverified payload
 * would let anyone delete any connection by guessing a user id.
 *
 * Returns the payload's `user_id` — Instagram's app-scoped id, matching
 * `providerUserId` — or null if anything about the request fails to check out.
 */
function parseSignedRequest(signed: string): { userId: string } | null {
  const secret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || "";
  if (!secret) {
    console.error("[instagram] cannot verify signed request — app secret is not set");
    return null;
  }

  const [signature, payload] = String(signed).split(".");
  if (!signature || !payload) return null;

  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    // Meta uses base64url; normalise rather than compare across alphabets.
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const given = signature.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Constant-time, via the same helper the OAuth state check uses: this compares
  // a secret-derived value against attacker-supplied input.
  if (!safeEqual(expected, given)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const userId = String(decoded?.user_id ?? "");
    return userId ? { userId } : null;
  } catch {
    return null;
  }
}

/**
 * Meta's Deauthorize Callback.
 *
 * Fired when someone removes Quantalog from their Instagram account's connected
 * apps. The token is already dead by then, so the job here is to stop showing
 * the account as connected and stop the scheduler retrying with it.
 *
 * Answers 200 to a *verified* request whether or not a connection was found —
 * Meta retries on a non-2xx, and there is nothing to retry when the row is
 * already gone. An unverified request gets 400 and changes nothing.
 */
async function handleDeauthorize(req: Request, res: Response): Promise<void> {
  const parsed = parseSignedRequest(String(req.body?.signed_request ?? ""));
  if (!parsed) {
    console.warn("[instagram] deauthorize request failed signature verification");
    res.status(400).json({ error: "invalid signed_request" });
    return;
  }

  const conn = await SocialConnection.findOneAndDelete({
    provider: "instagram",
    providerUserId: parsed.userId,
  });

  if (conn) {
    await pauseInstagramSchedules(String(conn.userId));
    // No account identifiers in the log — this line exists to confirm the
    // callback is wired up and firing, which does not require naming anyone.
    console.log("[instagram] deauthorized: connection removed");
  }

  res.json({ success: true });
}

/**
 * Meta posts `signed_request` as a form field, not as JSON.
 *
 * The app registers only `express.json()` globally, which leaves `req.body`
 * empty for a form-encoded POST — so both callbacks would reject every genuine
 * request from Meta as unsigned. Scoped to these two paths rather than added
 * globally: nothing else here takes a form post, and a parser applied to every
 * route is surface for no gain. `express.json()` is stacked behind it because
 * Meta's own dashboard test tool has been known to send JSON.
 */
const metaCallbackBody = [
  express.urlencoded({ extended: false, limit: "16kb" }),
  express.json({ limit: "16kb" }),
];

router.post("/deauthorize", metaCallbackBody, asyncHandler(handleDeauthorize));
// Meta sends a POST, but the dashboard's URL validator issues a GET. Answering
// both keeps the callback verifiable there without a second route.
router.get("/deauthorize", (_req: Request, res: Response) => {
  res.json({ success: true });
});

/**
 * Meta's Data Deletion Request callback.
 *
 * Required to answer in Meta's own format: a JSON body carrying a `url` where
 * the user can check the status of their deletion, and a `confirmation_code`.
 * A response that omits either fails Meta's validation, so the shape here is not
 * ours to choose.
 *
 * The deletion itself is immediate rather than queued. Everything this app holds
 * for an Instagram user is one connection row and the schedules pointing at it,
 * both of which are removed synchronously — so the status page has a settled
 * answer to give by the time anyone loads it.
 */
async function handleDataDeletion(req: Request, res: Response): Promise<void> {
  const parsed = parseSignedRequest(String(req.body?.signed_request ?? ""));
  if (!parsed) {
    console.warn("[instagram] data deletion request failed signature verification");
    res.status(400).json({ error: "invalid signed_request" });
    return;
  }

  const conn = await SocialConnection.findOneAndDelete({
    provider: "instagram",
    providerUserId: parsed.userId,
  });

  if (conn) {
    // The schedules go too, not just paused: this is a deletion request, and
    // keeping the content someone asked us to erase is the thing it forbids.
    await ScheduledPost.deleteMany({ userId: conn.userId, provider: "instagram" }).catch((e) => {
      console.error("[instagram] could not delete schedules:", (e as Error).message);
    });
  }

  // Derived from the account id rather than random, so the same request twice
  // yields the same code — Meta may retry, and two codes for one deletion would
  // make the status page unanswerable. Hashed rather than echoed: the code ends
  // up in a URL, and the raw account id is not ours to put there.
  const confirmationCode = createHmac("sha256", jwtSecret())
    .update(`instagram-deletion:${parsed.userId}`)
    .digest("hex")
    .slice(0, 24);

  console.log("[instagram] data deletion processed");

  res.json({
    url: `${studioBase()}/data-deletion?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

router.post("/data-deletion", metaCallbackBody, asyncHandler(handleDataDeletion));
// Same reasoning as the deauthorize GET above: the dashboard validates the URL
// with a GET before it will accept it.
router.get("/data-deletion", (_req: Request, res: Response) => {
  res.json({
    url: `${studioBase()}/data-deletion`,
    confirmation_code: "",
  });
});

export default router;
