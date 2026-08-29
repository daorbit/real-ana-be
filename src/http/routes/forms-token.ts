import { Router, type Response } from "express";
import { createHmac } from "node:crypto";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";

/**
 * Short-lived proof that a browser may act for a workspace inside the forms
 * service.
 *
 * The forms service runs as its own app, embedded in an iframe, and knows a
 * workspace only by the id in its URL. For form definitions that is fine — a
 * form is reachable by id anyway, that being what a share link is. It stops
 * being fine for the Razorpay credentials a workspace charges through: a
 * workspace id is not a secret, and anyone who has seen one could otherwise
 * overwrite those keys and quietly redirect every payment into their own
 * account.
 *
 * So the session stays here, where it belongs, and the forms service is handed
 * a token instead. Signed with `FORMS_SERVICE_SECRET`, which both services
 * already share for the internal calls going the other way.
 */
const router = Router();

/** Matches the forms service's own window. Long enough for a working session. */
const TTL_SECONDS = 60 * 60;

/**
 * Editor, not viewer: this token gates writing payment credentials, and
 * someone who may only read a workspace's analytics has no business changing
 * where its money lands.
 */
const MINIMUM_ROLE = "editor" as const;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mints a token for the workspace named in the path.
 *
 * The role check is the whole point: the caller's membership is looked up
 * fresh, so someone removed from a workspace this morning cannot mint a token
 * for it this afternoon on a session issued last week.
 */
router.post(
  "/:wid/forms-token",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const secret = process.env.FORMS_SERVICE_SECRET;
    if (!secret) {
      // Fails closed, exactly as `forms-internal` does. A token endpoint that
      // signs with an empty key would hand out forgeable credentials.
      console.error("[forms-token] FORMS_SERVICE_SECRET is not set — refusing");
      return res.status(503).json({ error: "forms integration is not configured" });
    }

    const workspace = await requireWorkspace(req, res, MINIMUM_ROLE);
    if (!workspace) return; // requireWorkspace has already answered

    const workspaceId = String(workspace._id);
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const payload = `${workspaceId}.${expiresAt}`;

    res.json({
      token: `${payload}.${sign(payload, secret)}`,
      expiresAt,
    });
  }),
);

export default router;
