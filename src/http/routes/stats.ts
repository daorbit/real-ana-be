import { Router, Response } from "express";
import { Site } from "../../modules/analytics/models/Site.js";
import { Membership } from "../../modules/workspace/models/Membership.js";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
import { computeStats } from "../../modules/analytics/stats.service.js";

const router = Router();
router.use(requireAuth);

// Per-site stats (still available)
router.get("/:siteId/stats", async (req: AuthedRequest, res: Response) => {
  const siteId = String(req.params.siteId);

  // Reached through the site's workspace rather than `Site.userId`: the field
  // records who added the site, which stopped being the same question as who
  // may read it once workspaces could be shared.
  const site = await Site.findOne({ siteId });
  if (!site) return res.status(404).json({ error: "site not found" });

  const member = await Membership.exists({
    workspaceId: site.workspaceId,
    userId: req.userId,
  });
  if (!member) return res.status(404).json({ error: "site not found" });
  const stats = await computeStats([siteId], String(req.query.range ?? "24h"));
  res.json(stats);
});

export default router;
