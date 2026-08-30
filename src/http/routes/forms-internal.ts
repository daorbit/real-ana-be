import { Router, Request, Response } from "express";
import {
  formLimits,
  recordFormSubmission,
  hasQuota,
  spendQuota,
} from "../../modules/billing/quota.service.js";
import { generateForm, formsAiReady } from "../../modules/forms-ai/generate.js";
import { parseGeneratedForm } from "../../modules/forms-ai/form-schema.js";
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

/**
 * Draft a form from a sentence.
 *
 * Metered as an Orbit question, on the same allowance as the assistant: it is
 * the same models and the same cost to us, and a workspace that has spent its
 * month asking Orbit things has spent its month. Two meters over one budget
 * would only mean explaining to a customer why their AI ran out twice.
 *
 * Spent only once a form actually comes back. A refusal, a timeout, or an
 * answer we could not read costs the customer nothing — they have no way to
 * tell a bad prompt from a busy model, so charging for it would read as the
 * product taking their credit and giving nothing.
 */
router.post(
  "/generate/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;

    const { workspaceId } = req.params;

    if (!formsAiReady()) {
      return res.status(503).json({ error: "form generation is not configured" });
    }

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    if (!prompt.trim()) return res.status(400).json({ error: "prompt required" });

    // Checked before the model is called, so a workspace with nothing left
    // waits on nothing. The spend afterwards is what actually reserves it.
    if (!(await hasQuota(workspaceId, "orbit"))) {
      return res.status(402).json({
        error: "quota_exceeded",
        code: "quota_exceeded",
        kind: "orbit_questions",
        message: "This workspace has used its AI questions for the period.",
      });
    }

    /**
     * The form being refined, on a follow-up.
     *
     * Read through the same parser the model's own output goes through. It
     * arrives from a browser by way of the forms service, so it is no more
     * trusted than a generation — and a bad field type reaching the model as an
     * example is how it learns to emit more of them.
     */
    const prior = req.body?.previous ? parseGeneratedForm(req.body.previous) : null;

    const result = await generateForm(prompt, prior?.ok ? prior.form : undefined);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    // After the work, never before. A spend that precedes a failed generation
    // bills for nothing delivered.
    await spendQuota(workspaceId, "orbit");

    res.json({ form: result.form, model: result.model });
  }),
);

export default router;
