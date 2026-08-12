import { Router, Response } from "express";
import { Form } from "../../modules/forms/models/Form.js";
import { Submission } from "../../modules/forms/models/Submission.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { resolveAccess, isDenied, requireWorkspace } from "../../modules/workspace/access.service.js";
import {
  cleanFields,
  cleanSettings,
  applyFieldEdit,
  hasSubmissions,
  presentForm,
  type CleanField,
} from "../../modules/forms/forms.service.js";
import { buildCsv, presentSubmission } from "../../modules/forms/submissions.service.js";
import { canCreateForm, canExportSubmissions } from "../../modules/billing/quota.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";

/**
 * Form CRUD and the submissions a form has collected.
 *
 * Two mount points, because the two halves are addressed differently: creating
 * and listing are workspace-scoped (`/api/workspaces/:wid/forms`) while
 * everything about one form is addressed by its own id, since a form id is
 * enough to find its workspace and asking the client to repeat it only invites
 * the two to disagree.
 *
 * Every route resolves access through `resolveAccess`, never through
 * `Form.findOne({ _id, createdBy })`: a form belongs to a workspace, not to the
 * person who happened to click New — otherwise a colleague could not fix a typo
 * in their own team's form.
 */

export const workspaceFormsRouter = Router({ mergeParams: true });
workspaceFormsRouter.use(requireAuth);
workspaceFormsRouter.use(blockDemoWrites);

export const formRouter = Router();
formRouter.use(requireAuth);
formRouter.use(blockDemoWrites);

/**
 * Load a form and check the caller's access to the workspace that owns it.
 *
 * A form in a workspace the caller cannot reach answers 404 rather than 403,
 * matching `resolveAccess`: a 403 would confirm the id names a real form, and
 * form ids would become enumerable. Insufficient *role* inside a workspace they
 * can already see is a genuine 403 — they know it exists.
 */
async function loadForm(
  req: AuthedRequest,
  res: Response,
  minimum: WorkspaceRole = "viewer",
): Promise<InstanceType<typeof Form> | null> {
  const form = await Form.findById(req.params.id).catch(() => null);
  if (!form) {
    res.status(404).json({ error: "form not found" });
    return null;
  }

  const access = await resolveAccess(req, minimum, String(form.get("workspaceId")));
  if (isDenied(access)) {
    // The workspace-level 404 is passed through unchanged: "you are not a member
    // of the workspace that owns this" must read exactly like "no such form".
    res.status(access.status).json({ error: access.status === 404 ? "form not found" : access.error });
    return null;
  }

  return form;
}

/** Every form in the workspace, newest first. */
workspaceFormsRouter.get("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;

  const forms = await Form.find({ workspaceId: ws.id }).sort({ createdAt: -1 });
  res.json(forms.map(presentForm));
});

/**
 * How long this workspace keeps submissions.
 *
 * Lives here rather than on the workspace PATCH because it is a forms rule, and
 * because it deserves the stricter role: it is the one setting whose effect is
 * irreversible deletion of a customer's leads.
 */
workspaceFormsRouter.get("/retention", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;
  res.json({ submissionRetentionDays: ws.get("submissionRetentionDays") ?? 0 });
});

workspaceFormsRouter.put("/retention", async (req: AuthedRequest, res: Response) => {
  // Admin, not editor: this schedules the permanent deletion of stored leads,
  // which is not day-to-day form editing.
  const ws = await requireWorkspace(req, res, "admin");
  if (!ws) return;

  const days = Number(req.body?.submissionRetentionDays);
  if (!Number.isFinite(days) || days < 0 || days > 3650)
    return res.status(400).json({ error: "retention must be between 0 and 3650 days (0 keeps submissions forever)" });

  ws.set("submissionRetentionDays", Math.trunc(days));
  await ws.save();
  res.json({ submissionRetentionDays: ws.get("submissionRetentionDays") });
});

/**
 * Create a form. Always a draft.
 *
 * No plan check here — `maxForms` counts published forms, and refusing someone
 * a draft is refusing them the thing they would have upgraded to publish.
 */
workspaceFormsRouter.post("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;

  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  if (name.length > 120) return res.status(400).json({ error: "name is too long" });

  // A form with no fields is legal to create and illegal to publish: the
  // builder opens on an empty canvas, and rejecting that would mean the first
  // thing a new user sees is an error.
  const fields = req.body?.fields === undefined ? { ok: true as const, value: [] } : cleanFields(req.body.fields);
  if (!fields.ok) return res.status(400).json({ error: fields.error });

  const settings = cleanSettings(req.body?.settings, fields.value);
  if (!settings.ok) return res.status(400).json({ error: settings.error });

  const form = await Form.create({
    workspaceId: ws.id,
    createdBy: req.userId,
    siteId: req.body?.siteId || null,
    name,
    fields: fields.value,
    settings: settings.value,
  });

  res.status(201).json(presentForm(form));
});

formRouter.get("/:id", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res);
  if (!form) return;
  res.json(presentForm(form));
});

/**
 * Edit a form.
 *
 * The interesting part is `applyFieldEdit`: once the form has answers stored
 * against its keys, a field cannot change type and cannot be deleted — removal
 * becomes hiding, so the stored answers keep a column that describes them.
 */
formRouter.patch("/:id", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res, "editor");
  if (!form) return;

  const update: Record<string, unknown> = {};

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "name cannot be empty" });
    if (name.length > 120) return res.status(400).json({ error: "name is too long" });
    update.name = name;
  }

  if (req.body?.siteId !== undefined) update.siteId = req.body.siteId || null;

  let fields = (form.get("fields") as CleanField[]) ?? [];

  if (req.body?.fields !== undefined) {
    const cleaned = cleanFields(req.body.fields);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });

    const reconciled = applyFieldEdit(fields, cleaned.value, await hasSubmissions(form));
    if (!reconciled.ok) return res.status(409).json({ error: reconciled.error });

    fields = reconciled.value;
    update.fields = fields;
  }

  if (req.body?.settings !== undefined) {
    // Validated against the field list as it will be *after* this edit, so a
    // `dedupFieldKey` pointing at a field being added in the same request is
    // accepted and one pointing at a field being removed is caught.
    const settings = cleanSettings(req.body.settings, fields);
    if (!settings.ok) return res.status(400).json({ error: settings.error });
    // Merged into the stored object rather than replacing it: the builder's
    // panels each save their own slice, and a whole-object write would let the
    // theme panel blank out the notification addresses.
    for (const [key, value] of Object.entries(settings.value)) update[`settings.${key}`] = value;
  }

  if (!Object.keys(update).length) return res.status(400).json({ error: "nothing to update" });

  const updated = await Form.findByIdAndUpdate(form.id, { $set: update }, { new: true });
  res.json(presentForm(updated!));
});

/**
 * Publish a form: this is the point the plan limit applies, and the point the
 * form must actually be fillable.
 */
formRouter.post("/:id/publish", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res, "editor");
  if (!form) return;

  const fields = ((form.get("fields") as CleanField[]) ?? []).filter((f) => !f.hidden);
  if (!fields.length)
    return res.status(400).json({ error: "add at least one field before publishing this form" });

  // Excludes itself, so re-publishing a form that is already live is never
  // blocked by the cap it is already counted against.
  const allowed = await canCreateForm(String(form.get("workspaceId")), form.id);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error });

  form.set("status", "published");
  await form.save();
  res.json(presentForm(form));
});

/**
 * Stop accepting responses without deleting anything.
 *
 * Distinct from delete on purpose: a closed form keeps its submissions and its
 * URL, so a campaign that ended still shows what it collected and a visitor
 * following an old link gets the owner's `closedMessage` rather than a 404.
 */
formRouter.post("/:id/close", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res, "editor");
  if (!form) return;

  form.set("status", "closed");
  await form.save();
  res.json(presentForm(form));
});

/** Reopen a closed form. Re-checks the cap, since closing freed a slot someone else may have taken. */
formRouter.post("/:id/reopen", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res, "editor");
  if (!form) return;

  const allowed = await canCreateForm(String(form.get("workspaceId")), form.id);
  if (!allowed.ok) return res.status(402).json({ error: allowed.error });

  form.set("status", "published");
  await form.save();
  res.json(presentForm(form));
});

/**
 * Delete a form and everything it collected.
 *
 * Admin-only, and it takes the submissions with it — leaving them would strand
 * a pile of personal data under a form id nothing points at, which is precisely
 * the row a data-deletion request would later fail to find.
 */
formRouter.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res, "admin");
  if (!form) return;

  await Submission.deleteMany({ formId: form.id });
  await form.deleteOne();
  res.json({ ok: true });
});

/** One page of submissions, newest first. */
formRouter.get("/:id/submissions", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res);
  if (!form) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [rows, total] = await Promise.all([
    Submission.find({ formId: form.id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Submission.countDocuments({ formId: form.id }),
  ]);

  res.json({
    submissions: rows.map(presentSubmission),
    total,
    page,
    limit,
    // Sent alongside so the table can render a column per field without a
    // second request, including for fields since retired.
    fields: form.get("fields"),
  });
});

/**
 * Download every submission as CSV.
 *
 * Plan-gated server-side as well as hidden in the UI — the export is the whole
 * value of the stored leads, so a hidden button is only the polite half.
 */
formRouter.get("/:id/submissions.csv", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res);
  if (!form) return;

  const allowed = await canExportSubmissions(String(form.get("workspaceId")));
  if (!allowed.ok) return res.status(402).json({ error: allowed.error });

  const csv = await buildCsv(form);
  const filename = String(form.get("name"))
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename || "submissions"}.csv"`);
  // A BOM, so Excel opens a UTF-8 export as UTF-8 rather than mangling every
  // non-ASCII name in the file.
  res.send(`﻿${csv}`);
});

formRouter.delete("/:id/submissions/:sid", async (req: AuthedRequest, res: Response) => {
  const form = await loadForm(req, res, "editor");
  if (!form) return;

  // Scoped by form as well as id, so an id from another form is a 404 rather
  // than a deletion.
  const result = await Submission.deleteOne({ _id: req.params.sid, formId: form.id });
  if (!result.deletedCount) return res.status(404).json({ error: "submission not found" });

  // The counter is denormalised, so it has to come down with the row — a list
  // page showing 40 next to a table of 39 is a bug report waiting to happen.
  await Form.updateOne({ _id: form.id }, { $inc: { submissionCount: -1 } });
  res.json({ ok: true });
});
