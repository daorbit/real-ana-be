import { Router, Response } from "express";
import { Form } from "../../modules/forms/models/Form.js";
import { Submission } from "../../modules/forms/models/Submission.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveAccess, isDenied } from "../../modules/workspace/access.service.js";
import { normalizeFields, lockedFieldKeys, violatesFieldLock } from "../../modules/forms/forms.service.js";
import { canCreateForm, canExportSubmissions } from "../../modules/billing/quota.service.js";

/**
 * Authed lead-form management: create/list/edit/publish/close/delete, plus
 * reading and exporting the submissions each form has collected.
 *
 * Two mount points in `app.ts`: `/api/workspaces/:wid/forms` for
 * create/list, and `/api/forms/:id` for everything that names one form
 * directly — a detail/update/delete route has no workspace id in its URL, so
 * access is resolved from the form's own `workspaceId` instead of `:wid`.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

function present(form: InstanceType<typeof Form>) {
  return {
    id: form.id,
    name: form.get("name"),
    formKey: form.get("formKey"),
    status: form.get("status"),
    fields: form.get("fields"),
    settings: form.get("settings"),
    siteId: form.get("siteId"),
    underReview: form.get("underReview"),
    createdAt: form.get("createdAt"),
    updatedAt: form.get("updatedAt"),
  };
}

/**
 * Access to a form named by `:id`, resolved through the form's own
 * `workspaceId` — never `Form.findOne({ _id, userId })`, for the same reason
 * given in `access.service.ts`: existence and permission are different
 * questions, and a form belongs to a workspace, not to its creator.
 *
 * A form in a workspace the caller is not a member of reads as "not found",
 * matching the existing convention so form ids are not enumerable.
 */
async function resolveFormAccess(
  req: AuthedRequest,
  res: Response,
  minimum: "viewer" | "editor" | "admin" = "viewer",
): Promise<InstanceType<typeof Form> | null> {
  const form = await Form.findById(req.params.id);
  if (!form) {
    res.status(404).json({ error: "form not found" });
    return null;
  }

  const access = await resolveAccess(req, minimum, String(form.get("workspaceId")));
  if (isDenied(access)) {
    res.status(access.status).json({ error: access.error });
    return null;
  }

  return form;
}

// ---- /api/workspaces/:wid/forms ----

router.get("/", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "viewer");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const forms = await Form.find({ workspaceId: access.workspace.id }).sort({ createdAt: -1 });
  res.json(forms.map(present));
});

router.post("/", async (req: AuthedRequest, res: Response) => {
  const access = await resolveAccess(req, "editor");
  if (isDenied(access)) return res.status(access.status).json({ error: access.error });

  const name = String(req.body?.name ?? "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "name is required" });

  const gate = await canCreateForm(access.workspace.id);
  // A draft always creates freely — the cap is on published forms. Checked
  // here anyway so a workspace already at the cap gets the upgrade message up
  // front rather than discovering it only when they try to publish.
  if (!gate.ok && String(req.body?.status ?? "draft") === "published") {
    return res.status(402).json({ error: gate.error });
  }

  const fieldsResult = normalizeFields(
    req.body?.fields ?? [{ label: "Email", type: "email", required: true }],
  );
  if ("error" in fieldsResult) return res.status(400).json({ error: fieldsResult.error });

  const form = await Form.create({
    workspaceId: access.workspace.id,
    createdBy: req.userId,
    name,
    siteId: req.body?.siteId || undefined,
    fields: fieldsResult.fields,
    settings: req.body?.settings ?? {},
  });

  res.status(201).json(present(form));
});

// ---- /api/forms/:id ----

router.get("/:id", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "viewer");
  if (!form) return;
  res.json(present(form));
});

router.patch("/:id", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "editor");
  if (!form) return;

  const update: Record<string, unknown> = {};

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "name cannot be empty" });
    update.name = name;
  }

  if (req.body?.fields !== undefined) {
    const fieldsResult = normalizeFields(req.body.fields);
    if ("error" in fieldsResult) return res.status(400).json({ error: fieldsResult.error });

    const locked = await lockedFieldKeys(form.id);
    const violation = violatesFieldLock(fieldsResult.fields, locked);
    if (violation) return res.status(400).json({ error: violation });

    update.fields = fieldsResult.fields;
  }

  if (req.body?.settings !== undefined) {
    update.settings = { ...(form.get("settings") as object), ...req.body.settings };
  }

  if (req.body?.siteId !== undefined) update.siteId = req.body.siteId || null;

  if (!Object.keys(update).length) return res.status(400).json({ error: "nothing to update" });

  const updated = await Form.findByIdAndUpdate(form.id, { $set: update }, { new: true });
  res.json(present(updated as InstanceType<typeof Form>));
});

router.post("/:id/publish", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "editor");
  if (!form) return;

  if ((form.get("fields") as unknown[]).length === 0) {
    return res.status(400).json({ error: "add at least one field before publishing" });
  }

  const gate = await canCreateForm(String(form.get("workspaceId")), form.id);
  if (!gate.ok) return res.status(402).json({ error: gate.error });

  form.set("status", "published");
  await form.save();
  res.json(present(form));
});

router.post("/:id/close", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "editor");
  if (!form) return;

  form.set("status", "closed");
  await form.save();
  res.json(present(form));
});

router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "admin");
  if (!form) return;

  await Submission.deleteMany({ formId: form.id });
  await Form.deleteOne({ _id: form.id });
  res.json({ ok: true });
});

// ---- submissions ----

function presentSubmission(s: InstanceType<typeof Submission>) {
  return {
    id: s.id,
    data: s.get("data"),
    referrer: s.get("referrer"),
    utm: s.get("utm"),
    overQuota: s.get("overQuota"),
    createdAt: s.get("createdAt"),
  };
}

router.get("/:id/submissions", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "viewer");
  if (!form) return;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  const [submissions, total] = await Promise.all([
    Submission.find({ formId: form.id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Submission.countDocuments({ formId: form.id }),
  ]);

  res.json({ submissions: submissions.map(presentSubmission), total, page, limit });
});

/**
 * Any cell that opens with `=`, `+`, `-`, or `@` is prefixed with a single
 * quote before it reaches the file. Submission data is fully
 * attacker-controlled and Excel/Sheets execute formulas on open — this is the
 * entire defense against that, and it must run on every cell, not just ones
 * that look suspicious.
 */
function csvCell(value: unknown): string {
  let s = String(value ?? "");
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  const escaped = s.replace(/"/g, '""');
  return `"${escaped}"`;
}

router.get("/:id/submissions.csv", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "viewer");
  if (!form) return;

  const gate = await canExportSubmissions(String(form.get("workspaceId")));
  if (!gate.ok) return res.status(402).json({ error: gate.error });

  const fields = form.get("fields") as { key: string; label: string }[];
  const submissions = await Submission.find({ formId: form.id }).sort({ createdAt: -1 }).limit(20_000);

  const header = ["Submitted at", ...fields.map((f) => f.label)].map(csvCell).join(",");
  const rows = submissions.map((s) => {
    const data = s.get("data") as Record<string, string>;
    return [String(s.get("createdAt")), ...fields.map((f) => data[f.key] ?? "")].map(csvCell).join(",");
  });

  res.type("text/csv");
  res.set("Content-Disposition", `attachment; filename="${form.get("name")}-submissions.csv"`);
  res.send([header, ...rows].join("\n"));
});

router.delete("/:id/submissions/:sid", async (req: AuthedRequest, res: Response) => {
  const form = await resolveFormAccess(req, res, "editor");
  if (!form) return;

  const result = await Submission.deleteOne({ _id: req.params.sid, formId: form.id });
  if (!result.deletedCount) return res.status(404).json({ error: "submission not found" });
  res.json({ ok: true });
});

export default router;
