import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { GoalTarget } from "../../modules/dashboards/models/GoalTarget.js";
import { Site } from "../../modules/analytics/models/Site.js";
import {
  parseTargetDraft,
  targetProgress,
  workspaceTargets,
  type TargetDraft,
} from "../../modules/dashboards/goal-targets.service.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";
import { canCreateFeature } from "../../modules/billing/quota.service.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

async function validateRefs(workspaceId: string, draft: TargetDraft): Promise<string | null> {
  if (draft.siteId) {
    const site = await Site.exists({ siteId: draft.siteId, workspaceId });
    if (!site) return "site not found";
  }
  return null;
}

async function siteIdsOf(workspaceId: string): Promise<string[]> {
  const sites = await Site.find({ workspaceId }).select("siteId");
  return sites.map((s) => String(s.siteId));
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res);
    if (!ws) return;
    res.json(await workspaceTargets(ws.id));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    const draft = parseTargetDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    const refError = await validateRefs(ws.id, draft);
    if (refError) return res.status(400).json({ error: refError });

    const allowed = await canCreateFeature(ws.id, "goalTargets");
    if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);

    const target = await GoalTarget.create({ workspaceId: ws.id, ...draft, createdBy: req.userId });
    res.status(201).json(await targetProgress(target, await siteIdsOf(ws.id)));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "goal not found" });

    const target = await GoalTarget.findOne({ _id: req.params.id, workspaceId: ws.id });
    if (!target) return res.status(404).json({ error: "goal not found" });

    const draft = parseTargetDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    const refError = await validateRefs(ws.id, draft);
    if (refError) return res.status(400).json({ error: refError });

    target.set(draft);
    await target.save();
    res.json(await targetProgress(target, await siteIdsOf(ws.id)));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "goal not found" });

    const target = await GoalTarget.findOne({ _id: req.params.id, workspaceId: ws.id });
    if (!target) return res.status(404).json({ error: "goal not found" });
    await target.deleteOne();
    res.status(204).end();
  }),
);

export default router;
