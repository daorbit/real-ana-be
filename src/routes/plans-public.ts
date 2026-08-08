import { Router, Request, Response } from "express";
import { listResolvedPlans, listResolvedOrbitPlans } from "../lib/planPricing.js";

/**
 * Public, unauthenticated plan catalogue — feeds the marketing site's
 * pricing section so it never drifts from what checkout actually charges.
 */
const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listResolvedPlans());
});

/**
 * The Orbit AI tiers, on their own path rather than merged into the list above.
 *
 * The pricing page renders them as a separate section — they are a separate
 * purchase, and a single mixed array would have every consumer filtering it
 * back apart by slug prefix.
 */
router.get("/orbit", async (_req: Request, res: Response) => {
  res.json(await listResolvedOrbitPlans());
});

export default router;
