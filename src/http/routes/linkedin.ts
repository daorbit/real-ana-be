import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { SocialConnection } from "../../modules/identity/models/SocialConnection.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchLinkedInProfile,
  linkedInConfigured,
  revokeLinkedInToken,
} from "../../infra/http-client/linkedin-auth.js";
import {
  LinkedInApiError,
  createImagePost,
  uploadImage,
} from "../../infra/http-client/linkedin-post.js";
import { checkImageDataUrl } from "../../infra/storage/cloudinary.js";
import { decryptSecret, encryptSecret, safeEqual } from "../../shared/utils/crypto-box.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { dashboardCors } from "../middleware/cors.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { badRequest, forbidden } from "../../shared/errors/index.js";

/**
 * Connecting a LinkedIn account, and publishing to it.
 *
 * Mounted at `/api/auth/linkedin`. It sits beside the auth routes rather than
 * inside them because two of these endpoints are not API calls at all: the
 * start and callback routes are browser navigations that redirect, and mixing
 * them into a router where every other handler answers JSON to a fetch would
 * blur that distinction.
 *
 * ## Why the state is a JWT
 *
 * This project authenticates with bearer tokens and keeps no server-side
 * session or cookie. That is a problem for OAuth, because the two hops that
 * matter here are top-level browser navigations: the redirect to LinkedIn and
 * the redirect back. Neither carries an `Authorization` header, so by the time
 * LinkedIn returns the code there is nothing on the request identifying who
 * started the flow.
 *
 * The state parameter therefore carries that identity itself, as a short-lived
 * JWT signed with the same secret as every other token here. It proves three
 * things at once with no stored record: that the callback belongs to a flow we
 * started (it is signed), which user started it (`userId`), and that it is
 * recent (`expiresIn`). The random `nonce` keeps two flows begun in the same
 * second from producing an identical string.
 */

const router = Router();

// Preflight for the JSON routes below. `DELETE`, and a `POST` carrying an
// `Authorization` header, both trigger one, and it arrives before any of the
// per-route middleware would run.
router.options("*", dashboardCors);

const STATE_SECRET = process.env.JWT_SECRET ?? "dev-secret";
/** Long enough to read a consent screen, short enough that a leaked URL goes stale. */
const STATE_TTL = "10m";
/** The share card is a 1200x630 PNG; the ceiling is generous but bounded. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type StatePayload = { userId: string; nonce: string; kind: "linkedin-oauth" };

/**
 * Where the browser is sent once the flow finishes, with the outcome in the
 * query string so the studio can raise a toast.
 *
 * Read from configuration rather than from the request: an open redirect that
 * takes its destination from a parameter is exactly the bug OAuth callbacks are
 * known for.
 */
function studioUrl(status: string, detail?: string): string {
  const base = (process.env.STUDIO_BASE_URL ?? "https://studio-quantalog.daorbit.in").replace(/\/+$/, "");
  const params = new URLSearchParams({ linkedin: status });
  if (detail) params.set("reason", detail);
  return `${base}/?${params.toString()}`;
}

/**
 * Start the flow.
 *
 * Authenticated with the JWT in the query string rather than a header, because
 * this endpoint is reached by assigning to `window.location` — a navigation,
 * which cannot carry one. The token is the same one the app already holds; it
 * travels over TLS, is immediately exchanged for the state token, and the URL
 * it appears in is replaced by the redirect rather than being kept.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    if (!linkedInConfigured()) {
      return res.redirect(studioUrl("error", "not_configured"));
    }

    const token = String(req.query.token ?? "");
    if (!token) return res.redirect(studioUrl("error", "not_signed_in"));

    let userId: string;
    try {
      const payload = jwt.verify(token, STATE_SECRET) as { userId: string; demo?: boolean };
      // A demo session is read-only and has no real user row to attach a
      // connection to, so it is refused here rather than failing at the upsert.
      if (payload.demo) return res.redirect(studioUrl("error", "demo"));
      userId = payload.userId;
    } catch {
      return res.redirect(studioUrl("error", "not_signed_in"));
    }

    const state = jwt.sign(
      { userId, nonce: randomBytes(16).toString("hex"), kind: "linkedin-oauth" } satisfies StatePayload,
      STATE_SECRET,
      { expiresIn: STATE_TTL },
    );

    res.redirect(buildAuthorizeUrl(state));
  }),
);

/**
 * The callback LinkedIn redirects to.
 *
 * Every failure path ends in a redirect back to the studio carrying a short
 * reason code, never a raw LinkedIn error: this route renders in the user's
 * address bar, and an API error string is neither useful nor safe there.
 */
router.get(
  "/callback",
  asyncHandler(async (req: Request, res: Response) => {
    // The user pressed Cancel on the consent screen. A normal outcome, not an
    // error worth logging.
    if (req.query.error) {
      const denied = req.query.error === "user_cancelled_login"
        || req.query.error === "user_cancelled_authorize";
      return res.redirect(studioUrl(denied ? "cancelled" : "error", "denied"));
    }

    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code) return res.redirect(studioUrl("error", "missing_code"));
    if (!state) return res.redirect(studioUrl("error", "invalid_state"));

    let userId: string;
    try {
      const payload = jwt.verify(state, STATE_SECRET) as StatePayload;
      // The `kind` claim stops any other token this app signs — a login token
      // above all — from being replayed here as state.
      if (!safeEqual(payload.kind ?? "", "linkedin-oauth")) throw new Error("wrong kind");
      userId = payload.userId;
    } catch {
      return res.redirect(studioUrl("error", "invalid_state"));
    }

    let token;
    let profile;
    try {
      token = await exchangeCodeForToken(code);
      profile = await fetchLinkedInProfile(token.accessToken);
    } catch (e) {
      // The message is safe to log — the clients above build it from a status
      // code only, never from the request body or the response.
      console.error("[linkedin] connect failed:", e instanceof Error ? e.message : e);
      return res.redirect(studioUrl("error", "linkedin_failed"));
    }

    try {
      // Upsert on (userId, provider), which is the collection's unique key:
      // connecting a second time replaces the token and refreshes the profile
      // instead of leaving a duplicate row behind.
      await SocialConnection.findOneAndUpdate(
        { userId, provider: "linkedin" },
        {
          $set: {
            providerUserId: profile.sub,
            name: profile.name,
            email: profile.email,
            picture: profile.picture,
            accessToken: encryptSecret(token.accessToken),
            expiresAt: token.expiresAt,
            scope: token.scope,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (e) {
      console.error("[linkedin] could not save connection:", e instanceof Error ? e.message : e);
      return res.redirect(studioUrl("error", "save_failed"));
    }

    res.redirect(studioUrl("connected"));
  }),
);

/**
 * Whether the current user has LinkedIn connected, and as whom.
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
      provider: "linkedin",
    }).select("name email picture expiresAt");

    if (!conn) return res.json({ connected: false });

    // Reported rather than hidden, so the panel can offer "Reconnect" before
    // the user writes a caption and discovers the problem at publish time.
    const expired = conn.expiresAt.getTime() <= Date.now();

    res.json({
      connected: true,
      expired,
      profile: {
        name: conn.name,
        email: conn.email,
        picture: conn.picture,
      },
    });
  }),
);

/**
 * Disconnect.
 *
 * The stored row goes either way. Revocation is attempted first so the token
 * stops working at LinkedIn too, but a failure there must not leave the user
 * still showing as connected in an app they just disconnected from.
 */
router.delete(
  "/",
  dashboardCors,
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const conn = await SocialConnection.findOne({
      userId: req.userId,
      provider: "linkedin",
    }).select("+accessToken");

    if (!conn) return res.json({ connected: false });

    const plain = decryptSecret(conn.accessToken);
    if (plain) {
      const revoked = await revokeLinkedInToken(plain);
      if (!revoked) console.warn("[linkedin] revoke declined; deleting local connection anyway");
    }

    await conn.deleteOne();
    res.json({ connected: false });
  }),
);

/**
 * Publish a post to the connected member's own feed.
 *
 * The caption and image come from the Share Panel as it already holds them:
 * the card is drawn on a canvas in the browser and exists only as a PNG data
 * URL, so the bytes are sent here and forwarded to LinkedIn. There is no hosted
 * URL to hand over instead, and LinkedIn requires the bytes regardless.
 */
router.post(
  "/post",
  dashboardCors,
  requireAuth,
  blockDemoWrites,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const caption = String(req.body?.caption ?? "").trim();
    const image = String(req.body?.image ?? "");

    if (!caption) throw badRequest("Caption cannot be empty.");
    if (!image) throw badRequest("Image is required.");

    // Reuses the avatar upload's validator: same base64 data-URL shape, same
    // allowed formats, so there is one definition of "an acceptable image".
    const parsed = checkImageDataUrl(image, MAX_IMAGE_BYTES);
    if ("error" in parsed) throw badRequest(parsed.error);

    const conn = await SocialConnection.findOne({
      userId: req.userId,
      provider: "linkedin",
    }).select("+accessToken");

    if (!conn) throw badRequest("Please connect your LinkedIn account first.");
    if (!conn.providerUserId) throw badRequest("Please reconnect your LinkedIn account.");

    if (conn.expiresAt.getTime() <= Date.now()) {
      // 403 with a flag the client keys off to swap the button for "Reconnect".
      throw forbidden("Your LinkedIn connection has expired. Please reconnect LinkedIn.", {
        reconnect: true,
      });
    }

    const accessToken = decryptSecret(conn.accessToken);
    if (!accessToken) {
      throw forbidden("Your LinkedIn connection is no longer valid. Please reconnect LinkedIn.", {
        reconnect: true,
      });
    }

    const bytes = Buffer.from(image.split(",")[1], "base64");

    try {
      const uploaded = await uploadImage(accessToken, conn.providerUserId, bytes, parsed.mime);
      const post = await createImagePost(accessToken, conn.providerUserId, caption, uploaded.urn);
      res.json({ posted: true, postUrl: post.postUrl });
    } catch (e) {
      if (e instanceof LinkedInApiError) {
        // Status only — never the response body, which can echo the token.
        console.error(`[linkedin] publish failed (${e.kind}, status ${e.status})`);

        if (e.kind === "auth") {
          // The token is dead. Expire it locally so the panel stops offering to
          // post with a credential that cannot work, rather than retrying.
          await SocialConnection.updateOne(
            { _id: conn._id },
            { $set: { expiresAt: new Date(0) } },
          );
          throw forbidden("Your LinkedIn connection has expired. Please reconnect LinkedIn.", {
            reconnect: true,
          });
        }
        if (e.kind === "permission") {
          throw forbidden(
            "LinkedIn refused the post. Reconnect LinkedIn to grant posting permission.",
            { reconnect: true },
          );
        }
        if (e.kind === "rate-limit") {
          throw badRequest("LinkedIn is rate limiting posts right now. Please try again shortly.");
        }
        throw badRequest(
          e.message.startsWith("image")
            ? "Unable to upload the image to LinkedIn."
            : "Unable to publish the LinkedIn post.",
        );
      }
      throw e;
    }
  }),
);

export default router;
