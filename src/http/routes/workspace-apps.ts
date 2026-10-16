import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { isWorkspaceApp, setAppEnabled } from "../../modules/workspace/apps.service.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

router.put("/:wid/apps/:appId", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "admin");
  if (!ws) return;
  if (!isWorkspaceApp(req.params.appId)) return res.status(404).json({ error: "unknown app" });
  const apps = await setAppEnabled(ws.id, req.params.appId, Boolean(req.body?.enabled));
  res.json({ apps });
});

export default router;
