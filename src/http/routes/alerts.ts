import { Router, Response } from "express";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { currentPlan } from "../../modules/billing/quota.service.js";
import { getPlanCatalogEntry } from "../../modules/billing/plans.catalog.js";
import {
  alertsOverview,
  currentAlertConfig,
  saveAlertConfig,
  sendTestAlert,
} from "../../modules/alerts/alerts.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

async function requireAlertsWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "alerts")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.alerts });
    return null;
  }
  return ws;
}

async function planOf(workspaceId: string) {
  return (await currentPlan(workspaceId)) ?? getPlanCatalogEntry("free")!;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireAlertsWorkspace(req, res);
    if (!ws) return;
    const plan = await planOf(ws.id);
    res.json(await alertsOverview(ws.id, plan.alertCheckHours));
  }),
);

router.put(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireAlertsWorkspace(req, res, "editor");
    if (!ws) return;

    const wantsWhatsApp = req.body?.channels?.whatsapp === true;
    const [plan, current] = await Promise.all([planOf(ws.id), currentAlertConfig(ws.id)]);
    if (wantsWhatsApp && !current.channels.whatsapp && !plan.whatsappReports) {
      return planLimit(
        res,
        `WhatsApp alerts are not included in the ${plan.name} plan — upgrade to use them`,
        { kind: "whatsapp_alerts", label: "WhatsApp alerts", plan: plan.name },
        "plan_required",
      );
    }

    const saved = await saveAlertConfig(ws.id, req.body);
    if (typeof saved === "string") return res.status(400).json({ error: saved });
    res.json(await alertsOverview(ws.id, plan.alertCheckHours));
  }),
);

router.post(
  "/test",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireAlertsWorkspace(req, res, "editor");
    if (!ws) return;
    res.json(await sendTestAlert({ id: ws.id, name: String(ws.get("name") ?? "") }));
  }),
);

export default router;
