import { Router, Response } from "express";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { currentPlan } from "../../modules/billing/quota.service.js";
import { getPlanCatalogEntry } from "../../modules/billing/plans.catalog.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { digestById, digestHistory, generateDigest, latestDigest } from "../../modules/insights/insights.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const HOUR_MS = 60 * 60 * 1000;
const REFRESHES_PER_HOUR = 3;
const FIRST_RUN_WINDOW_MS = 10 * 60 * 1000;

async function requireInsightsWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "insights")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.insights });
    return null;
  }
  return ws;
}

async function planFor(workspaceId: string) {
  return (await currentPlan(workspaceId)) ?? getPlanCatalogEntry("free")!;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireInsightsWorkspace(req, res);
    if (!ws) return;

    const [plan, existing] = await Promise.all([planFor(ws.id), latestDigest(ws.id)]);
    let digest = existing;
    if (!digest && !(await overRateLimit(`insights-first:${ws.id}`, 1, FIRST_RUN_WINDOW_MS)))
      digest = await generateDigest(ws.id);

    res.json({
      digest,
      history: await digestHistory(ws.id, plan.insightWeeks),
      canRefresh: plan.insightRefresh,
    });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireInsightsWorkspace(req, res);
    if (!ws) return;
    const digest = await digestById(ws.id, req.params.id);
    if (!digest) return res.status(404).json({ error: "insights not found" });
    res.json(digest);
  }),
);

router.post(
  "/refresh",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireInsightsWorkspace(req, res, "editor");
    if (!ws) return;

    const plan = await planFor(ws.id);
    if (!plan.insightRefresh)
      return planLimit(
        res,
        `Refreshing insights on demand isn't included in the ${plan.name} plan. They update every Monday.`,
        { kind: "insight_refresh", plan: plan.name },
        "plan_required",
      );
    if (await overRateLimit(`insights-refresh:${ws.id}`, REFRESHES_PER_HOUR, HOUR_MS))
      return res.status(429).json({ error: "Insights were refreshed a few times already. Try again later" });

    res.json(await generateDigest(ws.id));
  }),
);

export default router;
