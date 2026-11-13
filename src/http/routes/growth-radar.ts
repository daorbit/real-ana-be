import { Router, Response } from "express";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { currentPlan } from "../../modules/billing/quota.service.js";
import { getPlanCatalogEntry } from "../../modules/billing/plans.catalog.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { plannedScanAt, runScan } from "../../modules/growth-radar/scan.service.js";
import {
  listOpportunities,
  opportunityDetail,
  radarOverview,
  scanHistory,
} from "../../modules/growth-radar/opportunity.queries.js";
import { addNote, recordAction, updateOpportunity } from "../../modules/growth-radar/opportunity.writes.js";
import { detectorCatalog, radarConfig, saveRadarConfig } from "../../modules/growth-radar/settings.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

const HOUR_MS = 60 * 60 * 1000;
const RESCANS_PER_HOUR = 3;
const FIRST_SCAN_WINDOW_MS = 10 * 60 * 1000;

async function requireRadarWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "growthRadar")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.growthRadar });
    return null;
  }
  return ws;
}

async function planFor(workspaceId: string) {
  return (await currentPlan(workspaceId)) ?? getPlanCatalogEntry("free")!;
}

function nextScanAt(ws: { get: (path: string) => unknown }) {
  return plannedScanAt(ws.get("apps.growthRadar.nextScanAt") as Date | null);
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res);
    if (!ws) return;

    const [plan, overview] = await Promise.all([planFor(ws.id), radarOverview(ws.id)]);
    let result = overview;
    if (!overview.lastScan && !req.isDemo && !(await overRateLimit(`radar-first:${ws.id}`, 1, FIRST_SCAN_WINDOW_MS))) {
      await runScan(ws.id, "first");
      result = await radarOverview(ws.id);
    }

    res.json({ ...result, nextScanAt: nextScanAt(ws), canRescan: plan.radarRescan, historyDays: plan.radarHistoryDays });
  }),
);

router.get(
  "/opportunities",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res);
    if (!ws) return;
    const plan = await planFor(ws.id);
    const view = req.query.view === "snoozed" ? "snoozed" : "history";
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    res.json(await listOpportunities(ws.id, view, plan.radarHistoryDays, before && !Number.isNaN(before.getTime()) ? before : undefined));
  }),
);

router.get(
  "/opportunities/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res);
    if (!ws) return;
    const detail = await opportunityDetail(ws.id, String(req.params.id));
    if (!detail) return res.status(404).json({ error: "Opportunity not found" });
    res.json(detail);
  }),
);

router.patch(
  "/opportunities/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res, "editor");
    if (!ws) return;
    res.json(await updateOpportunity(ws.id, String(req.params.id), req.userId!, req.body));
  }),
);

router.post(
  "/opportunities/:id/notes",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res, "editor");
    if (!ws) return;
    res.json(await addNote(ws.id, String(req.params.id), req.userId!, req.body));
  }),
);

router.post(
  "/opportunities/:id/action",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res, "editor");
    if (!ws) return;
    res.json(await recordAction(ws.id, String(req.params.id), req.userId!, req.body));
  }),
);

router.get(
  "/scans",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res);
    if (!ws) return;
    const plan = await planFor(ws.id);
    res.json({ scans: await scanHistory(ws.id, plan.radarHistoryDays) });
  }),
);

router.post(
  "/scan",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res, "editor");
    if (!ws) return;

    const plan = await planFor(ws.id);
    if (!plan.radarRescan)
      return planLimit(
        res,
        `Scanning on demand isn't included in the ${plan.name} plan. Growth Radar scans every morning.`,
        { kind: "radar_rescan", plan: plan.name },
        "plan_required",
      );
    if (await overRateLimit(`radar-scan:${ws.id}`, RESCANS_PER_HOUR, HOUR_MS))
      return res.status(429).json({ error: "Growth Radar has scanned a few times already. Try again later." });

    await runScan(ws.id, "manual");
    const overview = await radarOverview(ws.id);
    res.json({ ...overview, nextScanAt: nextScanAt(ws), canRescan: true, historyDays: plan.radarHistoryDays });
  }),
);

router.get(
  "/settings",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res);
    if (!ws) return;
    res.json({ config: await radarConfig(ws.id), detectors: detectorCatalog() });
  }),
);

router.put(
  "/settings",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireRadarWorkspace(req, res, "editor");
    if (!ws) return;
    const saved = await saveRadarConfig(ws.id, req.body);
    if (typeof saved === "string") return res.status(400).json({ error: saved });
    res.json({ config: saved, detectors: detectorCatalog() });
  }),
);

export default router;
