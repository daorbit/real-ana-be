import { Router, Request, Response } from "express";
import { publicPopups } from "../../modules/popups/popups.service.js";

const router = Router();

const CACHE_HEADER = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

router.get("/:siteId", async (req: Request<{ siteId: string }>, res: Response) => {
  const siteId = String(req.params.siteId ?? "").slice(0, 64);
  res.set("Cache-Control", CACHE_HEADER);
  if (!siteId) return res.json({ popups: [] });
  try {
    res.json({ popups: await publicPopups(siteId) });
  } catch (e) {
    console.error("[popups] public config failed:", (e as Error).message);
    res.set("Cache-Control", "no-store");
    res.json({ popups: [] });
  }
});

export default router;
