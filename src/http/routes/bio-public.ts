import { Router, Request, Response } from "express";
import { normaliseSlug, slugProblem } from "../../modules/bio/bio-draft.js";
import { publicBioPage, recordBioClick, recordBioView } from "../../modules/bio/bio.service.js";

const router = Router();

const CACHE_HEADER = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";

function slugFrom(req: Request<{ slug: string }>): string | null {
  const slug = normaliseSlug(req.params.slug);
  return slugProblem(slug) ? null : slug;
}

router.get("/:slug", async (req: Request<{ slug: string }>, res: Response) => {
  const slug = slugFrom(req);
  if (!slug) return res.status(404).json({ error: "page not found" });
  try {
    const page = await publicBioPage(slug);
    if (!page) {
      res.set("Cache-Control", "public, max-age=30, s-maxage=30");
      return res.status(404).json({ error: "page not found" });
    }
    res.set("Cache-Control", CACHE_HEADER);
    res.json(page);
  } catch (e) {
    console.error("[bio] public page failed:", (e as Error).message);
    res.set("Cache-Control", "no-store");
    res.status(503).json({ error: "page unavailable" });
  }
});

router.post("/:slug/view", async (req: Request<{ slug: string }>, res: Response) => {
  res.set("Cache-Control", "no-store");
  const slug = slugFrom(req);
  if (slug) {
    await recordBioView(slug, req.get("user-agent") ?? "", req.headers).catch((e: Error) =>
      console.error("[bio] view not recorded:", e.message),
    );
  }
  res.status(204).end();
});

router.get("/:slug/go/:linkId", async (req: Request<{ slug: string; linkId: string }>, res: Response) => {
  res.set("Cache-Control", "no-store");
  const slug = slugFrom(req);
  const linkId = String(req.params.linkId ?? "").slice(0, 24);
  const target = slug
    ? await recordBioClick(slug, linkId, req.get("user-agent") ?? "", req.headers).catch((e: Error) => {
        console.error("[bio] click not recorded:", e.message);
        return null;
      })
    : null;
  if (!target) return res.status(404).json({ error: "link not found" });
  res.redirect(302, target);
});

export default router;
