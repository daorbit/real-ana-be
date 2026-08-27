import { Router, Request, Response } from "express";
import { formLimits, recordFormSubmission } from "../../modules/billing/quota.service.js";
import { asyncHandler } from "../middleware/async-handler.js";

/**
 * What the forms service is allowed to do, and what it has used.
 *
 * Lead capture runs as its own service with its own database, so it cannot read
 * a subscription directly — but plans and quota belong to billing, and having
 * two services hold their own opinion of a customer's plan is how the two
 * disagree. This is the one place the answer comes from.
 *
 * Not `requireAuth`: the caller is a server, not a browser, and there is no
 * session behind a public form submission at 3am. `FORMS_SERVICE_SECRET` is the
 * credential instead, exactly as `CRON_SECRET` is for the scheduler.
 */
const router = Router();

/**
 * Rejects anything that cannot prove it is the forms service.
 *
 * A missing secret fails closed. An endpoint that hands out a workspace's plan
 * and increments its billing meter is not one to leave open because an env var
 * was forgotten.
 */
function authorize(req: Request, res: Response): boolean {
  const secret = process.env.FORMS_SERVICE_SECRET;
  if (!secret) {
    console.error("[forms-internal] FORMS_SERVICE_SECRET is not set — refusing");
    res.status(503).json({ error: "forms integration is not configured" });
    return false;
  }
  if (req.get("authorization") !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * The caps and the submission meter for one workspace.
 *
 * The forms service caches this briefly rather than calling per submission —
 * see its own client — so this stays a plain read with no side effects.
 */
router.get(
  "/limits/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;
    res.json(await formLimits(req.params.workspaceId));
  }),
);

/**
 * Records one stored submission against the workspace's cycle.
 *
 * Called after the response has been saved, so it never refuses: the row
 * exists either way, and losing the count is better than pretending the
 * response did not arrive. Whether the next one is accepted is decided by the
 * limits above.
 */
router.post(
  "/submissions/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;
    await recordFormSubmission(req.params.workspaceId);
    res.status(204).end();
  }),
);

export default router;
