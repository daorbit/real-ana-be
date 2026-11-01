import { Router, Request, Response } from "express";
import { publicExperiments } from "../../modules/experiments/experiments-public.service.js";

const router = Router();

const CACHE_HEADER = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

router.get("/:siteId", async (req: Request<{ siteId: string }>, res: Response) => {
  const siteId = String(req.params.siteId ?? "").slice(0, 64);
  res.set("Cache-Control", CACHE_HEADER);
  if (!siteId) return res.json({ experiments: [] });
  try {
    res.json({ experiments: await publicExperiments(siteId) });
  } catch (e) {
    console.error("[experiments] public config failed:", (e as Error).message);
    res.set("Cache-Control", "no-store");
    res.json({ experiments: [] });
  }
});

export default router;
