import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Site } from "../../modules/analytics/models/Site.js";
import { Popup } from "../../modules/popups/models/Popup.js";
import { parsePopupDraft } from "../../modules/popups/popup-draft.js";
import { presentPopup, workspacePopups } from "../../modules/popups/popups.service.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { canCreateFeature } from "../../modules/billing/quota.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

async function requirePopupsWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "popups")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.popups });
    return null;
  }
  return ws;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requirePopupsWorkspace(req, res);
    if (!ws) return;
    res.json(await workspacePopups(ws.id));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requirePopupsWorkspace(req, res, "editor");
    if (!ws) return;

    const draft = parsePopupDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const [site, allowed] = await Promise.all([
      Site.exists({ siteId: draft.siteId, workspaceId: ws.id }),
      canCreateFeature(ws.id, "popups"),
    ]);
    if (!site) return res.status(400).json({ error: "site not found" });
    if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);

    const popup = await Popup.create({ workspaceId: ws.id, ...draft, createdBy: req.userId });
    res.status(201).json(presentPopup(popup));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requirePopupsWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "popup not found" });

    const draft = parsePopupDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const [popup, site] = await Promise.all([
      Popup.findOne({ _id: req.params.id, workspaceId: ws.id }),
      Site.exists({ siteId: draft.siteId, workspaceId: ws.id }),
    ]);
    if (!popup) return res.status(404).json({ error: "popup not found" });
    if (!site) return res.status(400).json({ error: "site not found" });

    popup.set(draft);
    await popup.save();
    res.json(presentPopup(popup));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requirePopupsWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "popup not found" });

    const result = await Popup.deleteOne({ _id: req.params.id, workspaceId: ws.id });
    if (!result.deletedCount) return res.status(404).json({ error: "popup not found" });
    res.status(204).end();
  }),
);

export default router;
