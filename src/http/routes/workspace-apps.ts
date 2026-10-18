import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { isWorkspaceApp, setAppEnabled } from "../../modules/workspace/apps.service.js";
import { onAppToggled } from "../../modules/workspace/app-hooks.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

router.put("/:wid/apps/:appId", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "admin");
  if (!ws) return;
  const appId = req.params.appId;
  if (!isWorkspaceApp(appId)) return res.status(404).json({ error: "unknown app" });
  const enabled = Boolean(req.body?.enabled);
  const [apps] = await Promise.all([setAppEnabled(ws.id, appId, enabled), onAppToggled(ws.id, appId, enabled)]);
  res.json({ apps });
});

export default router;
