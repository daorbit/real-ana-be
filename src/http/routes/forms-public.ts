import { Router, Request, Response } from "express";
import { Form } from "../../modules/forms/models/Form.js";
import { Submission } from "../../modules/forms/models/Submission.js";
import { clientIp } from "../../modules/analytics/enrich.js";
import {
  hashIp,
  dedupHash,
  issueTimingToken,
  checkTimingToken,
  isHoneypotTripped,
  str,
} from "../../modules/forms/antispam.js";
import { validateSubmissionData, checkFormCeiling, checkIpRateLimit, isDuplicate, shouldNotify, notifySubmission } from "../../modules/forms/submissions.service.js";
import { canAcceptSubmission } from "../../modules/billing/quota.service.js";
import { Subscription } from "../../modules/billing/models/Subscription.js";
import { PRESET_THEMES } from "../../modules/forms/forms.service.js";

/**
 * The public, unauthenticated half of forms: rendering a published form's
 * schema and accepting its submissions. Entirely attacker-controlled input —
 * see `FORMS.md`'s anti-abuse section for the full threat model this
 * implements.
 */
const router = Router();

/**
 * The theme catalog — same list the dashboard's gallery and the hosted page
 * both need, kept as one source of truth in `forms.service.ts` rather than
 * duplicated in either frontend. Public and cacheable: it's a fixed list of
 * design tokens, nothing workspace- or form-specific.
 */
router.get("/themes", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.json(PRESET_THEMES);
});

async function loadPublishedForm(formKey: string) {
  if (!formKey.startsWith("frm_") || formKey.length > 64) return null;
  return Form.findOne({ formKey, status: { $in: ["published", "closed"] } });
}

/**
 * Schema + settings for rendering, whitelisted field by field rather than
 * built by deleting keys off the document — a field added to `Form` later
 * must not leak here by default. Never `workspaceId`, `notifyEmails`,
 * `createdBy`, or any count.
 */
router.get("/:formKey", async (req: Request, res: Response) => {
  const form = await loadPublishedForm(String(req.params.formKey ?? ""));
  if (!form) return res.status(404).json({ error: "not found" });

  const settings = form.get("settings") as Record<string, unknown>;

  res.json({
    name: form.get("name"),
    status: form.get("status"),
    fields: (form.get("fields") as unknown[]).map((f) => {
      const field = f as Record<string, unknown>;
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        options: field.options,
        pageBreakAfter: field.pageBreakAfter,
      };
    }),
    settings: {
      submitText: settings.submitText,
      successMessage: settings.successMessage,
      redirectUrl: settings.redirectUrl,
      captchaEnabled: settings.captchaEnabled,
      logoUrl: settings.logoUrl,
      primaryColor: settings.primaryColor,
      closedMessage: settings.closedMessage,
      theme: settings.theme,
      themeOverrides: settings.themeOverrides,
    },
    timingToken: issueTimingToken(),
  });
});

router.post("/:formKey/submit", async (req: Request, res: Response) => {
  const form = await loadPublishedForm(String(req.params.formKey ?? ""));
  if (!form) return res.status(404).json({ error: "not found" });

  if (form.get("status") === "closed") {
    return res.status(410).json({ error: "this form is no longer accepting responses" });
  }

  // A hidden field no human fills in. Answered with the success shape so a
  // bot never learns it was caught — that only teaches it to stop filling the
  // field next time.
  if (isHoneypotTripped(req.body?.website)) {
    return res.status(202).json({ ok: true });
  }

  if (!checkTimingToken(req.body?.timingToken)) {
    return res.status(400).json({ error: "form expired — please reload and try again" });
  }

  const validated = validateSubmissionData(
    form.get("fields") as { key: string; type: string; required: boolean; options?: string[]; maxLength: number }[],
    req.body?.data,
  );
  if ("error" in validated) return res.status(400).json({ error: validated.error });

  const ipHash = hashIp(clientIp(req));
  if (!(await checkIpRateLimit(form.id, ipHash))) {
    return res.status(429).json({ error: "too many submissions from here — try again later" });
  }
  if (!(await checkFormCeiling(form.id))) {
    // Still accepted, not refused — a global ceiling flips the form into
    // review mode rather than dropping a possibly-legitimate lead during a
    // burst. Fall through.
  }

  const hash = dedupHash(validated.data);
  if (await isDuplicate(form.id, hash)) {
    // Reported as success — a duplicate is not the submitter's problem to see,
    // and telling them "already submitted" invites a retry loop.
    return res.status(200).json({ ok: true });
  }

  const workspaceId = String(form.get("workspaceId"));
  const overQuota = !(await canAcceptSubmission(workspaceId));

  const submission = await Submission.create({
    formId: form.id,
    workspaceId,
    data: validated.data,
    referrer: str(req.body?.referrer, 500),
    utm: {
      source: str(req.body?.utm?.source, 200),
      medium: str(req.body?.utm?.medium, 200),
      campaign: str(req.body?.utm?.campaign, 200),
    },
    ipHash,
    userAgent: str(req.headers["user-agent"], 300),
    dedupHash: hash,
    overQuota,
  });

  // Soft ceiling: over quota, keep accepting and storing, just stop counting
  // toward notifications — a dropped lead is lost revenue in a way a dropped
  // analytics event never is. See `plans.catalog.ts#monthlySubmissionQuota`.
  if (!overQuota) {
    Subscription.updateOne({ workspaceId }, { $inc: { submissionsUsed: 1 } }).catch(() => {});
  }

  if (!overQuota && (await shouldNotify(form.id))) {
    notifySubmission(form, validated.data).catch((e) =>
      console.error("[forms] notify failed:", (e as Error)?.message),
    );
  }

  const settings = form.get("settings") as { redirectUrl?: string; successMessage?: string };
  res.status(201).json({
    ok: true,
    submissionId: submission.id,
    redirectUrl: settings.redirectUrl || null,
    successMessage: settings.successMessage,
  });
});

export default router;
