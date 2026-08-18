import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { SocialConnection } from "../../modules/identity/models/SocialConnection.js";
import { User } from "../../modules/identity/models/User.js";
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
import { requireAuth, blockDemoWrites, signToken, AuthedRequest } from "../middleware/auth.js";
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

/**
 * What the flow is for.
 *
 * `connect` attaches LinkedIn to the account already signed in, and carries
 * that account's id. `login` signs someone in — there is no session yet, so
 * there is no `userId` to carry, and the account is found or created from the
 * verified profile at the far end.
 *
 * Both share one authorize/callback pair because LinkedIn matches the redirect
 * URI byte for byte against a registered list: a second callback path would
 * mean a second registration in the developer portal for no behavioural gain.
 */
type StateMode = "connect" | "login";

type StatePayload = {
  /** Absent on a login flow, which has no signed-in user yet. */
  userId?: string;
  mode: StateMode;
  nonce: string;
  kind: "linkedin-oauth";
};

/**
 * Where the browser is sent once the flow finishes, with the outcome in the
 * query string so the studio can raise a toast.
 *
 * Read from configuration rather than from the request: an open redirect that
 * takes its destination from a parameter is exactly the bug OAuth callbacks are
 * known for.
 */
function studioBase(): string {
  return (process.env.STUDIO_BASE_URL ?? "https://studio-quantalog.daorbit.in").replace(/\/+$/, "");
}

function studioUrl(status: string, detail?: string): string {
  const params = new URLSearchParams({ linkedin: status });
  if (detail) params.set("reason", detail);
  return `${studioBase()}/?${params.toString()}`;
}

/**
 * Where a sign-in attempt returns to: the login page, which knows how to store
 * a token and route onward.
 */
function loginUrl(status: string, detail?: string, token?: string): string {
  const base = studioBase();
  const params = new URLSearchParams({ linkedinLogin: status });
  if (detail) params.set("reason", detail);
  if (token) params.set("token", token);
  return `${base}/login?${params.toString()}`;
}

/**
 * Read the `mode` claim without verifying the signature.
 *
 * Used only to decide which page a failure redirects to, before the state has
 * been validated — the failure paths need a destination even when the state is
 * the thing that is wrong. Nothing is authorised on the strength of this: the
 * signature is still checked before the state is acted on, and the worst a
 * forged value achieves is an error message on the other page.
 */
function peekMode(state: string): StateMode {
  try {
    const decoded = jwt.decode(state) as StatePayload | null;
    return decoded?.mode === "login" ? "login" : "connect";
  } catch {
    return "connect";
  }
}

/**
 * Find or create the account behind a verified LinkedIn profile.
 *
 * Matched on the LinkedIn subject first, then on the email address. That second
 * step is what links LinkedIn to an account someone already has rather than
 * creating a parallel one — the same behaviour as the Google route, and safe
 * for the same reason: the profile came from an authorization-code exchange
 * against our own client secret, so the address is one LinkedIn vouches for.
 *
 * Throws when LinkedIn returned no email and there is no existing subject
 * match, since an account here is keyed by address and there is nothing to
 * create one from.
 */
async function resolveLoginUser(profile: {
  sub: string;
  name: string;
  givenName: string;
  familyName: string;
  email: string;
  picture: string;
}) {
  const bySub = await User.findOne({ linkedinId: profile.sub });
  if (bySub) return bySub;

  if (!profile.email) throw new Error("linkedin returned no email to sign in with");

  const existing = await User.findOne({ email: profile.email });
  if (existing) {
    existing.linkedinId = profile.sub;
    // Only fills a gap: a picture the user chose here is not replaced.
    if (!existing.avatarUrl) existing.avatarUrl = profile.picture;
    await existing.save();
    return existing;
  }

  const [first, ...rest] = profile.name.split(" ");
  // No passwordHash, and `role` left to the schema default — a LinkedIn signup
  // can no more ask to be an admin than a password signup can.
  return User.create({
    email: profile.email,
    name: profile.name || profile.email.split("@")[0],
    firstName: profile.givenName || first || "",
    lastName: profile.familyName || rest.join(" "),
    linkedinId: profile.sub,
    avatarUrl: profile.picture,
  });
}

/**
 * Start the flow, for either connecting or signing in.
 *
 * `?mode=login` needs no credential: nobody is signed in yet, which is the
 * point. The default, `connect`, is authenticated with the app's JWT in the
 * query string rather than a header, because this endpoint is reached by
 * assigning to `window.location` — a navigation, which cannot carry one. That
 * token travels over TLS, is exchanged immediately for the state token, and the
 * URL it appeared in is replaced by the redirect rather than kept.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    if (!linkedInConfigured()) {
      return res.redirect(studioUrl("error", "not_configured"));
    }

    const mode: StateMode = req.query.mode === "login" ? "login" : "connect";

    let userId: string | undefined;

    if (mode === "connect") {
      const token = String(req.query.token ?? "");
      if (!token) return res.redirect(studioUrl("error", "not_signed_in"));

      try {
        const payload = jwt.verify(token, STATE_SECRET) as { userId: string; demo?: boolean };
        // A demo session is read-only and has no real user row to attach a
        // connection to, so it is refused here rather than failing at the upsert.
        if (payload.demo) return res.redirect(studioUrl("error", "demo"));
        userId = payload.userId;
      } catch {
        return res.redirect(studioUrl("error", "not_signed_in"));
      }
    }

    const state = jwt.sign(
      {
        ...(userId ? { userId } : {}),
        mode,
        nonce: randomBytes(16).toString("hex"),
        kind: "linkedin-oauth",
      } satisfies StatePayload,
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
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");

    // Read the mode before anything else, so every failure below lands the user
    // back where they started — the login page for a sign-in, the studio for a
    // connect. It is read without trusting it: this is only a choice of
    // redirect target, and the signature is still verified before the state is
    // acted on.
    const wantedLogin = peekMode(state) === "login";
    const fail = (status: string, reason?: string) =>
      wantedLogin ? loginUrl(status, reason) : studioUrl(status, reason);

    // The user pressed Cancel on the consent screen. A normal outcome, not an
    // error worth logging.
    if (req.query.error) {
      const denied = req.query.error === "user_cancelled_login"
        || req.query.error === "user_cancelled_authorize";
      return res.redirect(fail(denied ? "cancelled" : "error", "denied"));
    }

    if (!code) return res.redirect(fail("error", "missing_code"));
    if (!state) return res.redirect(fail("error", "invalid_state"));

    let userId: string | undefined;
    let mode: StateMode;
    try {
      const payload = jwt.verify(state, STATE_SECRET) as StatePayload;
      // The `kind` claim stops any other token this app signs — a login token
      // above all — from being replayed here as state.
      if (!safeEqual(payload.kind ?? "", "linkedin-oauth")) throw new Error("wrong kind");
      mode = payload.mode === "login" ? "login" : "connect";
      userId = payload.userId;
      // A connect flow without a user is a malformed state, not a login.
      if (mode === "connect" && !userId) throw new Error("missing user");
    } catch {
      return res.redirect(fail("error", "invalid_state"));
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
      return res.redirect(fail("error", "linkedin_failed"));
    }

    // A login flow has no user yet: find one by LinkedIn subject, fall back to
    // the verified email so an existing password or Google account is linked
    // rather than duplicated, and create one only if neither matches.
    let issuedToken: string | null = null;
    if (mode === "login") {
      try {
        const resolved = await resolveLoginUser(profile);
        userId = resolved.id;
        issuedToken = signToken(resolved.id);
      } catch (e) {
        console.error("[linkedin] login failed:", e instanceof Error ? e.message : e);
        return res.redirect(loginUrl("error", "login_failed"));
      }
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
      // On a login flow the sign-in itself succeeded; failing to store the
      // posting token must not cost the user their session, so they are still
      // let in and simply arrive without LinkedIn connected for posting.
      if (!issuedToken) return res.redirect(studioUrl("error", "save_failed"));
    }

    // A login hands the freshly signed token to the app, which stores it and
    // completes the sign-in. This is the one place a token travels in a URL:
    // there is no session and no fetch here to answer, and the client strips it
    // from the address bar as soon as it has been read.
    if (issuedToken) return res.redirect(loginUrl("ok", undefined, issuedToken));

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

    // Whether the deployment can run the flow at all. Reported so the panel can
    // say "not configured" in place of a button, rather than navigating the
    // whole page to an endpoint that will only bounce straight back — which
    // reads to the user as the app reloading and losing their work.
    const configured = linkedInConfigured();

    if (!conn) return res.json({ connected: false, configured });

    // Reported rather than hidden, so the panel can offer "Reconnect" before
    // the user writes a caption and discovers the problem at publish time.
    const expired = conn.expiresAt.getTime() <= Date.now();

    res.json({
      connected: true,
      configured,
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
