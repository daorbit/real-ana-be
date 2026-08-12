import { Router, Request, Response } from "express";
import { Form } from "../../modules/forms/models/Form.js";
import { presentPublicForm } from "../../modules/forms/forms.service.js";
import { ingest } from "../../modules/forms/submissions.service.js";
import { hashIp, issueTimingToken } from "../../modules/forms/antispam.js";
import { clientIp } from "../../modules/analytics/enrich.js";
import { currentPlan } from "../../modules/billing/quota.service.js";

/**
 * The hosted form: rendering it, and taking what someone types into it.
 *
 * Unauthenticated and therefore entirely attacker-controlled, the same posture
 * as `contact-public.ts` and `newsletter-public.ts` — but generalised to a
 * schema the customer defined, which is the part that makes it harder. Nothing
 * here trusts the payload's shape: the fields that may be answered come from
 * the stored form, so keys a caller invents are dropped rather than stored.
 *
 * Addressed by `formKey`, never by Mongo id. The workspace is resolved from the
 * form server-side, so no internal id appears in a URL a visitor can read.
 */
const router = Router();

/** Loads a form by its public key, or answers 404. Never leaks whether a draft exists. */
async function loadPublicForm(formKey: string) {
  return Form.findOne({ formKey }).catch(() => null);
}

/**
 * The schema the hosted page renders, plus the timing token it must send back.
 *
 * The projection is a whitelist built in `presentPublicForm` — `workspaceId`,
 * `notifyEmails`, `createdBy` and the counters never appear, and a field added
 * to the schema next year is invisible here until someone decides otherwise.
 */
router.get("/:formKey", async (req: Request, res: Response) => {
  const form = await loadPublicForm(String(req.params.formKey));
  // A draft is not published, so to the outside world it does not exist. Same
  // answer as a key that was never issued, so drafts cannot be discovered by
  // probing.
  if (!form || form.get("status") === "draft")
    return res.status(404).json({ error: "form not found" });

  const plan = await currentPlan(String(form.get("workspaceId")));
  // Branding is resolved from the plan here rather than stored on the form: a
  // value the form carried would be a value a client could edit.
  const showBranding = !plan?.formsRemoveBranding;

  res.json({
    ...presentPublicForm(form, showBranding),
    // Issued per render and signed with its own timestamp, so the submit can
    // tell how long the page was open without the server keeping any state —
    // which matters because render and submit may hit different instances.
    timingToken: issueTimingToken(form.get("formKey") as string),
  });
});

/**
 * Take one submission.
 *
 * Failure modes are deliberately uneven. A bot gets the success shape (telling
 * it otherwise only teaches it to evade), a human over the per-IP limit gets a
 * 429 that says to wait, and a genuine validation error names the field so it
 * can be fixed. What never happens is a refusal on quota grounds — see
 * `canAcceptSubmission`.
 */
router.post("/:formKey/submit", async (req: Request, res: Response) => {
  const form = await loadPublicForm(String(req.params.formKey));
  if (!form || form.get("status") === "draft")
    return res.status(404).json({ error: "form not found" });

  if (form.get("status") === "closed") {
    const settings = (form.get("settings") as Record<string, unknown>) ?? {};
    return res.status(403).json({
      error: (settings.closedMessage as string) || "This form is no longer accepting responses.",
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const utm = (body.utm ?? {}) as Record<string, unknown>;

  const result = await ingest(form, body, {
    ip: clientIp(req),
    ipHash: hashIp(clientIp(req)),
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    referrer: String(body.referrer ?? "").slice(0, 500),
    // The only attribution v1 has. The visitor is on our domain, so there is no
    // shared `visitorHash` with the customer's tracker — these come off the link
    // that brought them here and nothing more.
    utm: {
      source: String(utm.source ?? "").slice(0, 200),
      medium: String(utm.medium ?? "").slice(0, 200),
      campaign: String(utm.campaign ?? "").slice(0, 200),
    },
  });

  if (result.status === "rejected") return res.status(result.code).json({ error: result.error });

  // A swallowed submission — honeypot, too-fast, or an exact repeat — is
  // answered exactly like a stored one. The difference must not be observable
  // from outside, or it is a detector someone can tune against.
  if (result.status === "swallowed") return res.status(202).json({ ok: true });

  res.status(201).json({
    ok: true,
    redirectUrl: result.redirectUrl || null,
    successMessage: result.successMessage || "",
  });
});

export default router;
