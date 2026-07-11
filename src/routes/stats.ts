import { Router, Response } from "express";
import { Site } from "../models/Site.js";
import { requireAuth, AuthedRequest } from "../auth.js";
import { computeStats } from "../stats-core.js";

const router = Router();
router.use(requireAuth);

// Per-site stats (still available)
router.get("/:siteId/stats", async (req: AuthedRequest, res: Response) => {
  const siteId = String(req.params.siteId);
  const site = await Site.findOne({ siteId, userId: req.userId });
  if (!site) return res.status(404).json({ error: "site not found" });
  const stats = await computeStats([siteId], String(req.query.range ?? "24h"));
  res.json(stats);
});

export default router;
