import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { BioPage } from "../../modules/bio/models/BioPage.js";
import { parseBioDraft } from "../../modules/bio/bio-draft.js";
import { isDuplicateSlug, workspaceBioPages } from "../../modules/bio/bio.service.js";
import { presentBioPage } from "../../modules/bio/bio-present.js";
import { bioPageStats } from "../../modules/bio/bio-stats.service.js";
import { resolveBioLink } from "../../modules/bio/bio-resolve.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { canCreateFeature, currentPlan } from "../../modules/billing/quota.service.js";
import { getPlanCatalogEntry } from "../../modules/billing/plans.catalog.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const SLUG_TAKEN = "That short link is already taken. Try another.";
const STATS_RANGES = [7, 30, 90, 365];

async function requireBioWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "bio")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.bio });
    return null;
  }
  return ws;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res);
    if (!ws) return;
    res.json(await workspaceBioPages(ws.id));
  }),
);

router.post(
  "/resolve",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;
    const resolved = await resolveBioLink(String(req.body?.url ?? ""));
    if (!resolved) return res.status(400).json({ error: "paste a full web link" });
    res.json(resolved);
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;

    const draft = parseBioDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const allowed = await canCreateFeature(ws.id, draft.kind === "release" ? "smartLinks" : "bioPages");
    if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);

    try {
      const page = await BioPage.create({ workspaceId: ws.id, ...draft, createdBy: req.userId });
      res.status(201).json(presentBioPage(page));
    } catch (error) {
      if (isDuplicateSlug(error)) return res.status(409).json({ error: SLUG_TAKEN });
      throw error;
    }
  }),
);

router.get(
  "/:id/stats",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res);
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "page not found" });

    const [page, plan] = await Promise.all([
      BioPage.findOne({ _id: req.params.id, workspaceId: ws.id }).select("kind links release"),
      currentPlan(ws.id),
    ]);
    if (!page) return res.status(404).json({ error: "page not found" });

    const maxDays = (plan ?? getPlanCatalogEntry("free")!).bioStatsDays;
    const asked = Number(req.query.days);
    const days = Math.min(STATS_RANGES.includes(asked) ? asked : 30, maxDays);
    const present = presentBioPage(page);
    const tracked =
      present.kind === "release"
        ? (present.release?.rows ?? []).filter((r) => r.enabled).map((r) => ({ id: r.id, label: r.name }))
        : present.links.filter((l) => l.enabled).map((l) => ({ id: l.id, label: l.label }));

    res.json(await bioPageStats(page.id, tracked, days, maxDays));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "page not found" });

    const draft = parseBioDraft(req.body);
    if (typeof draft === "string") return res.status(400).json({ error: draft });

    const page = await BioPage.findOne({ _id: req.params.id, workspaceId: ws.id });
    if (!page) return res.status(404).json({ error: "page not found" });
    if ((page.get("kind") ?? "profile") !== draft.kind) return res.status(400).json({ error: "a page can't change type" });

    page.set(draft);
    try {
      await page.save();
    } catch (error) {
      if (isDuplicateSlug(error)) return res.status(409).json({ error: SLUG_TAKEN });
      throw error;
    }
    res.json(presentBioPage(page));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireBioWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "page not found" });

    const result = await BioPage.deleteOne({ _id: req.params.id, workspaceId: ws.id });
    if (!result.deletedCount) return res.status(404).json({ error: "page not found" });
    res.status(204).end();
  }),
);

export default router;
