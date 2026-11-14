import express, { Router, Request, Response } from "express";
import { normaliseSlug, slugProblem } from "../../modules/bio/bio-draft.js";
import { publicBioPage } from "../../modules/bio/bio.service.js";
import { parseHit, recordBioHit } from "../../modules/bio/bio-hit.js";
import { bioPageUrl, bioPreviewHtml } from "../../modules/bio/bio-preview.js";
import { trackedIds } from "../../modules/bio/bio-present.js";
import { runAfterResponse } from "../../shared/utils/after-response.js";

const router = Router();

const CACHE_HEADER = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const PREVIEW_CACHE = "public, max-age=600, s-maxage=600";

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

router.get("/:slug/preview", async (req: Request<{ slug: string }>, res: Response) => {
  const slug = slugFrom(req);
  const page = slug ? await publicBioPage(slug).catch(() => null) : null;
  res.set("Vary", "User-Agent");
  if (!page) {
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(404).type("html").send("<!doctype html><title>Page not found</title>");
  }
  res.set("Cache-Control", PREVIEW_CACHE);
  res.type("html").send(bioPreviewHtml(page));
});

router.post("/:slug/hit", express.text({ type: "*/*", limit: "2kb" }), (req: Request<{ slug: string }>, res: Response) => {
  res.set("Cache-Control", "no-store");
  const slug = slugFrom(req);
  const hit = parseHit(req.body);
  if (slug && hit) runAfterResponse("bio hit", () => recordBioHit(slug, hit, req));
  res.status(204).end();
});

router.post("/:slug/view", (req: Request<{ slug: string }>, res: Response) => {
  res.set("Cache-Control", "no-store");
  const slug = slugFrom(req);
  if (slug) {
    runAfterResponse("bio view", () =>
      recordBioHit(slug, { type: "view", source: "other", linkId: "", newVisitor: false, referrer: "", campaign: "" }, req),
    );
  }
  res.status(204).end();
});

router.get("/:slug/go/:linkId", async (req: Request<{ slug: string; linkId: string }>, res: Response) => {
  res.set("Cache-Control", "no-store");
  const slug = slugFrom(req);
  const linkId = String(req.params.linkId ?? "").slice(0, 24);
  const page = slug ? await publicBioPage(slug).catch(() => null) : null;
  if (!slug || !page || !trackedIds(page).has(linkId)) return res.status(404).json({ error: "link not found" });
  const target = page.links.find((l) => l.id === linkId)?.url ?? page.release?.rows.find((r) => r.id === linkId)?.url;
  if (!target) return res.redirect(302, bioPageUrl(slug));
  runAfterResponse("bio click", () =>
    recordBioHit(slug, { type: "click", source: "other", linkId, newVisitor: false, referrer: "", campaign: "" }, req),
  );
  res.redirect(302, target);
});

export default router;
