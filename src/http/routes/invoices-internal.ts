import { Router, type Request, type Response } from "express";
import { isValidObjectId } from "mongoose";
import { asyncHandler } from "../middleware/async-handler.js";
import { invoiceServiceSecret } from "../../shared/utils/invoice-workspace-token.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { mailConfigured, sendOne } from "../../infra/mail/mailer.js";
import { documentEmailHtml, documentEmailText, readDocumentEmail } from "../../modules/invoicing/document-email.js";

const router = Router();

const LOGO_CID = "quantalog-logo";
const DAILY_EMAILS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function authorize(req: Request, res: Response): boolean {
  const secret = invoiceServiceSecret();
  if (!secret) {
    console.error("[invoices-internal] INVOICE_SERVICE_SECRET is not set, refusing");
    res.status(503).json({ error: "invoices integration is not configured" });
    return false;
  }
  if (req.get("authorization") !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

router.post(
  "/email/:workspaceId",
  asyncHandler(async (req: Request<{ workspaceId: string }>, res: Response) => {
    if (!authorize(req, res)) return;
    const { workspaceId } = req.params;

    if (!mailConfigured()) {
      return res.status(503).json({ error: "mail_not_configured", message: "Email sending is not set up yet." });
    }

    const email = readDocumentEmail(req.body);
    if (!email) {
      return res.status(400).json({ error: "invalid_input", message: "Add a recipient, a subject and a link." });
    }

    if (!isValidObjectId(workspaceId)) return res.status(404).json({ error: "not_found" });
    const workspace = await Workspace.findById(workspaceId).select("apps");
    if (!workspace) return res.status(404).json({ error: "not_found" });
    if (!appEnabled(workspace, "invoicing")) {
      return res.status(403).json({ error: "app_disabled", message: APP_DISABLED_MESSAGE.invoicing });
    }

    if (await overRateLimit(`invoice-email:${workspaceId}`, DAILY_EMAILS, DAY_MS)) {
      return res.status(429).json({ error: "rate_limited", message: "Daily email limit reached. Try again tomorrow." });
    }

    await sendOne(
      { email: email.to.join(", ") },
      email.subject,
      documentEmailText(email),
      documentEmailHtml(email, LOGO_CID),
      email.pdf ? [{ filename: email.pdf.filename, content: email.pdf.content, contentType: "application/pdf" }] : [],
      undefined,
      { cc: email.cc, replyTo: email.replyTo || undefined, fromName: `${email.senderName} via Quantalog` },
    );

    res.status(204).end();
  }),
);

export default router;
