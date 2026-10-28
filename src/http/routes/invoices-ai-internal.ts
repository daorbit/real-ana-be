import { Router, type Request, type Response } from "express";
import { isValidObjectId } from "mongoose";
import { asyncHandler } from "../middleware/async-handler.js";
import { authorizeInvoiceService } from "./invoices-internal-auth.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import { hasQuota, spendQuota } from "../../modules/billing/quota.service.js";
import { invoicesAiReady } from "../../modules/invoices-ai/ask-model.js";
import { readInvoiceContext, readInvoiceSnapshot } from "../../modules/invoices-ai/invoice-input.js";
import { readAttachment } from "../../modules/invoices-ai/attachment.js";
import { draftInvoice, type InvoiceAiResult } from "../../modules/invoices-ai/draft.js";
import { editInvoice } from "../../modules/invoices-ai/edit.js";
import { suggestGst } from "../../modules/invoices-ai/gst.js";

const router = Router();

type WorkspaceRequest = Request<{ workspaceId: string }>;

function refuse(res: Response, status: number, error: string, message: string) {
  res.status(status).json({ error, message });
}

async function allowed(req: WorkspaceRequest, res: Response): Promise<boolean> {
  if (!authorizeInvoiceService(req, res)) return false;
  const { workspaceId } = req.params;

  if (!invoicesAiReady()) {
    refuse(res, 503, "not_configured", "Orbit is not set up on this server.");
    return false;
  }
  if (!isValidObjectId(workspaceId)) {
    refuse(res, 404, "not_found", "Workspace not found.");
    return false;
  }
  const workspace = await Workspace.findById(workspaceId).select("apps");
  if (!workspace) {
    refuse(res, 404, "not_found", "Workspace not found.");
    return false;
  }
  if (!appEnabled(workspace, "invoicing")) {
    refuse(res, 403, "app_disabled", APP_DISABLED_MESSAGE.invoicing);
    return false;
  }
  if (!(await hasQuota(workspaceId, "orbit"))) {
    res.status(402).json({
      error: "quota_exceeded",
      code: "quota_exceeded",
      kind: "orbit_questions",
      message: "This workspace has used its AI questions for the period.",
    });
    return false;
  }
  return true;
}

async function reply(res: Response, workspaceId: string, result: InvoiceAiResult) {
  if (!result.ok) return refuse(res, result.status, "orbit_failed", result.error);
  await spendQuota(workspaceId, "orbit");
  res.json({ ops: result.ops, summary: result.summary, model: result.model });
}

router.post(
  "/draft/:workspaceId",
  asyncHandler(async (req: WorkspaceRequest, res: Response) => {
    if (!(await allowed(req, res))) return;
    const context = readInvoiceContext(req.body?.context);
    if (!context) return refuse(res, 400, "invalid_input", "Missing document context.");

    const read = await readAttachment(req.body?.attachment);
    if (!read.ok) return refuse(res, 400, "invalid_attachment", read.error);

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    await reply(res, req.params.workspaceId, await draftInvoice(prompt, context, read.attachment));
  }),
);

router.post(
  "/edit/:workspaceId",
  asyncHandler(async (req: WorkspaceRequest, res: Response) => {
    if (!(await allowed(req, res))) return;
    const context = readInvoiceContext(req.body?.context);
    const snapshot = readInvoiceSnapshot(req.body?.snapshot);
    if (!context || !snapshot) return refuse(res, 400, "invalid_input", "Missing the document to change.");

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    await reply(res, req.params.workspaceId, await editInvoice(prompt, snapshot, context));
  }),
);

router.post(
  "/gst/:workspaceId",
  asyncHandler(async (req: WorkspaceRequest, res: Response) => {
    if (!(await allowed(req, res))) return;
    const snapshot = readInvoiceSnapshot(req.body?.snapshot);
    if (!snapshot) return refuse(res, 400, "invalid_input", "Missing the document to check.");
    await reply(res, req.params.workspaceId, await suggestGst(snapshot));
  }),
);

export default router;
