import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/async-handler.js";
import { clientIp } from "../../modules/analytics/enrich.js";
import { incidentHistory, publicIncident, statusSummary } from "../../modules/status/summary.service.js";
import { confirmSubscription, subscribe, unsubscribe } from "../../modules/status/subscribers.service.js";
import { siteUrl } from "../../modules/status/emails.js";

const router = Router();

const CACHE = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";

function cached(res: Response) {
  res.set("Cache-Control", CACHE);
}

function tokenOf(req: Request): string {
  const raw = req.query.token ?? (req.body as Record<string, unknown> | undefined)?.token;
  return typeof raw === "string" ? raw.slice(0, 100) : "";
}

router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    cached(res);
    res.json(await statusSummary());
  }),
);

router.get(
  "/incidents",
  asyncHandler(async (req: Request, res: Response) => {
    const raw = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    cached(res);
    res.json(await incidentHistory(raw && !Number.isNaN(raw.getTime()) ? raw : undefined));
  }),
);

router.get(
  "/incidents/:id",
  asyncHandler(async (req: Request<{ id: string }>, res: Response) => {
    const incident = await publicIncident(req.params.id);
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    cached(res);
    res.json(incident);
  }),
);

router.post(
  "/subscribe",
  asyncHandler(async (req: Request, res: Response) => {
    await subscribe((req.body as Record<string, unknown> | undefined)?.email, clientIp(req));
    res.status(202).json({ ok: true });
  }),
);

router.get(
  "/confirm",
  asyncHandler(async (req: Request, res: Response) => {
    const ok = await confirmSubscription(tokenOf(req));
    res.redirect(303, `${siteUrl()}/status?${ok ? "subscribed=1" : "link=expired"}`);
  }),
);

router.get(
  "/unsubscribe",
  asyncHandler(async (req: Request, res: Response) => {
    await unsubscribe(tokenOf(req));
    res.redirect(303, `${siteUrl()}/status?unsubscribed=1`);
  }),
);

router.post(
  "/unsubscribe",
  asyncHandler(async (req: Request, res: Response) => {
    await unsubscribe(tokenOf(req));
    res.status(204).end();
  }),
);

export default router;
