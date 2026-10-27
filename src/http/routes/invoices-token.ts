import { Router, type Response } from "express";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import { signFormsWorkspaceToken } from "../../shared/utils/forms-workspace-token.js";
import { invoiceServiceSecret } from "../../shared/utils/invoice-workspace-token.js";

const router = Router();

const TTL_SECONDS = 60 * 60;

const MINIMUM_ROLE = "editor" as const;

router.post(
  "/:wid/invoices-token",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const secret = invoiceServiceSecret();
    if (!secret) {
      console.error("[invoices-token] INVOICE_SERVICE_SECRET is not set, refusing");
      return res.status(503).json({ error: "invoices integration is not configured" });
    }

    const workspace = await requireWorkspace(req, res, MINIMUM_ROLE);
    if (!workspace) return;

    if (!appEnabled(workspace, "invoicing")) {
      return res.status(403).json({ error: APP_DISABLED_MESSAGE.invoicing, code: "app_disabled" });
    }

    res.json(
      signFormsWorkspaceToken(
        secret,
        String(workspace._id),
        req.isDemo ? "" : String(req.userId ?? ""),
        TTL_SECONDS,
      ),
    );
  }),
);

export default router;
