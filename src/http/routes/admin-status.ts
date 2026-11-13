import { Router, Response } from "express";
import { requireAuth, requireAdmin, requireSuperAdmin, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import {
  adminStatusOverview,
  createIncident,
  deleteIncident,
  editIncident,
  postUpdate,
} from "../../modules/status/incidents.service.js";

const router = Router();
router.use(requireAuth, requireAdmin, requireSuperAdmin);

router.get(
  "/",
  asyncHandler(async (_req: AuthedRequest, res: Response) => {
    res.json(await adminStatusOverview());
  }),
);

router.post(
  "/incidents",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.status(201).json(await createIncident(req.body, req.userId!));
  }),
);

router.post(
  "/incidents/:id/updates",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await postUpdate(String(req.params.id), req.body, req.userId!));
  }),
);

router.patch(
  "/incidents/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await editIncident(String(req.params.id), req.body));
  }),
);

router.delete(
  "/incidents/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    await deleteIncident(String(req.params.id));
    res.status(204).end();
  }),
);

export default router;
