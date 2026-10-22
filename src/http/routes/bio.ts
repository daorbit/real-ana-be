import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { BioPage } from "../../modules/bio/models/BioPage.js";
import { parseBioDraft } from "../../modules/bio/bio-draft.js";
import { isDuplicateSlug, presentBioPage, workspaceBioPages } from "../../modules/bio/bio.service.js";
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

const SLUG_TAKEN = "That page address is already taken. Try another.";

async function requireBioWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "bio")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.bio });
    return null;
  }
  return ws;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res);
    if (!ws) return;
    res.json(await workspaceBioPages(ws.id));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;

    const draft = parseBioDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const allowed = await canCreateFeature(ws.id, "bioPages");
    if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);

    try {
      const page = await BioPage.create({ workspaceId: ws.id, ...draft, createdBy: req.userId });
      res.status(201).json(presentBioPage(page));
    } catch (error) {
      if (isDuplicateSlug(error)) return res.status(409).json({ error: SLUG_TAKEN });
      throw error;
    }
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "page not found" });

    const draft = parseBioDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const page = await BioPage.findOne({ _id: req.params.id, workspaceId: ws.id });
    if (!page) return res.status(404).json({ error: "page not found" });

    page.set(draft);
    try {
      await page.save();
    } catch (error) {
      if (isDuplicateSlug(error)) return res.status(409).json({ error: SLUG_TAKEN });
      throw error;
    }
    res.json(presentBioPage(page));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "page not found" });

    const result = await BioPage.deleteOne({ _id: req.params.id, workspaceId: ws.id });
    if (!result.deletedCount) return res.status(404).json({ error: "page not found" });
    res.status(204).end();
  }),
);

export default router;
