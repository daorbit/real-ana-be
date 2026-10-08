import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import {
  NavPrefsError,
  clearNavLinkLogo,
  saveNavPrefs,
  setNavLinkLogo,
} from "../../modules/workspace/nav-prefs.service.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const send = async (res: Response, run: () => Promise<unknown>) => {
  try {
    res.json({ navPrefs: await run() });
  } catch (e) {
    if (e instanceof NavPrefsError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
};

router.put(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "admin");
    if (!ws) return;
    await send(res, () => saveNavPrefs(ws, req.body));
  }),
);

router.post(
  "/links/:linkId/logo",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "admin");
    if (!ws) return;
    await send(res, () => setNavLinkLogo(ws, String(req.params.linkId), String(req.body?.file ?? "")));
  }),
);

router.delete(
  "/links/:linkId/logo",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "admin");
    if (!ws) return;
    await send(res, () => clearNavLinkLogo(ws, String(req.params.linkId)));
  }),
);

export default router;
