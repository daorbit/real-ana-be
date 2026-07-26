import { Router, Request, Response } from "express";
import { listResolvedPlans } from "../lib/planPricing.js";

/**
 * Public, unauthenticated plan catalogue — feeds the marketing site's
 * pricing section so it never drifts from what checkout actually charges.
 */
const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listResolvedPlans());
});

export default router;
