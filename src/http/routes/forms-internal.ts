import { Router, Request, Response } from "express";
import {
  formLimits,
  recordFormSubmission,
  hasQuota,
  spendQuota,
} from "../../modules/billing/quota.service.js";
import { generateForm, formsAiReady } from "../../modules/forms-ai/generate.js";
import { generateEdit, type EditSnapshot } from "../../modules/forms-ai/edit.js";
import { parseGeneratedForm } from "../../modules/forms-ai/form-schema.js";
import { resolveBranding } from "../../modules/branding/branding.service.js";
import { asyncHandler } from "../middleware/async-handler.js";


const router = Router();

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


router.get(
  "/limits/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;
    res.json(await formLimits(req.params.workspaceId));
  }),
);


router.post(
  "/submissions/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;
    await recordFormSubmission(req.params.workspaceId);
    res.status(204).end();
  }),
);


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

    if (!(await hasQuota(workspaceId, "orbit"))) {
      return res.status(402).json({
        error: "quota_exceeded",
        code: "quota_exceeded",
        kind: "orbit_questions",
        message: "This workspace has used its AI questions for the period.",
      });
    }


    const prior = req.body?.previous ? parseGeneratedForm(req.body.previous) : null;

    const mode = req.body?.mode === "edit" ? "edit" : "create";


    const result = await generateForm(
      prompt,
      prior?.ok ? prior.form : undefined,
      mode,
    );
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }


    await spendQuota(workspaceId, "orbit");

    res.json({ form: result.form, model: result.model });
  }),
);

/** The form as the builder describes it, sanity-checked before the model sees it. */
function readEditSnapshot(raw: unknown): EditSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.fields)) return null;

  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

  const fields = r.fields
    .slice(0, 100)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const f = entry as Record<string, unknown>;
      const id = str(f.id, 100);
      const type = str(f.type, 40);
      if (!id || !type) return null;
      return {
        id,
        type,
        label: str(f.label, 120) ?? "",
        required: f.required === true,
        options: Array.isArray(f.options)
          ? f.options
              .map((o) => str(o, 120))
              .filter((o): o is string => Boolean(o))
              .slice(0, 40)
          : undefined,
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  return {
    title: str(r.title, 120),
    formDescription: str(r.formDescription, 500),
    submitLabel: str(r.submitLabel, 40),
    fields,
    theme:
      r.theme && typeof r.theme === "object"
        ? (r.theme as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Change a form that already exists.
 *
 * Separate from `/generate` because it answers a different question.
 * Generating asks "what should this form be" and rewrites the document to say
 * so — right for a first draft, destructive for an edit, where the author has
 * fields, wording and layout they never asked about. This asks "what should
 * change", and returns only that.
 *
 * The caller applies the operations to the form it is already holding, so
 * anything the model did not name is not merely preserved but never touched.
 * That is what lets layout survive: a grid and its columns are not in this
 * conversation at all.
 *
 * Metered identically to a generation — same models, same cost, same allowance.
 */
router.post(
  "/edit/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;

    const { workspaceId } = req.params;

    if (!formsAiReady()) {
      return res.status(503).json({ error: "form editing is not configured" });
    }

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    if (!prompt.trim()) return res.status(400).json({ error: "prompt required" });

    const snapshot = readEditSnapshot(req.body?.snapshot);
    if (!snapshot) return res.status(400).json({ error: "snapshot required" });

    if (!(await hasQuota(workspaceId, "orbit"))) {
      return res.status(402).json({
        error: "quota_exceeded",
        code: "quota_exceeded",
        kind: "orbit_questions",
        message: "This workspace has used its AI questions for the period.",
      });
    }

    const result = await generateEdit(prompt, snapshot);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    // After the work, never before.
    await spendQuota(workspaceId, "orbit");

    res.json({ ops: result.ops, model: result.model });
  }),
);

router.get(
  "/branding/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;
    const brand = await resolveBranding(req.params.workspaceId);
    res.json({
      name: brand.name,
      logoUrl: brand.logoUrl,
      accentColor: brand.accentColor,
      showPoweredBy: brand.showPoweredBy,
      poweredByLabel: brand.poweredByLabel,
      editable: brand.editable,
    });
  }),
);

export default router;
