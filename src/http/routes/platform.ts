import { Router, type Response } from "express";
import { requirePlatform, type PlatformRequest } from "../middleware/platform-auth.js";
import { PLATFORM_AUDIENCE } from "../../modules/platform/platform-token.js";
import { databaseHealth, metricsSummary, readRange } from "../../modules/platform/metrics.service.js";
import { listPlatformPayments } from "../../modules/platform/payments.service.js";
import { listPlatformSubscriptions } from "../../modules/platform/subscriptions.service.js";
import { listPlatformUsers, platformUserDetail } from "../../modules/platform/users.service.js";

const router = Router();

const CAPABILITIES = ["users", "billing", "payments", "metrics", "health"];

router.get("/capabilities", requirePlatform("products:read"), (_req: PlatformRequest, res: Response) => {
  res.json({ product: PLATFORM_AUDIENCE, connectorVersion: "v1", capabilities: CAPABILITIES });
});

router.get("/health", requirePlatform("products:read"), async (_req: PlatformRequest, res: Response) => {
  const checks = [await databaseHealth()];
  res.json({ ok: checks.every((check) => check.ok), product: PLATFORM_AUDIENCE, time: new Date().toISOString(), checks });
});

router.get("/metrics/summary", requirePlatform("overview:read"), async (req: PlatformRequest, res: Response) => {
  const { from, to } = readRange(req.query.from, req.query.to);
  res.json(await metricsSummary(from, to));
});

router.get("/users", requirePlatform("users:read"), async (req: PlatformRequest, res: Response) => {
  res.json(await listPlatformUsers(req.query));
});

router.get("/users/:userId", requirePlatform("users:read"), async (req: PlatformRequest, res: Response) => {
  const detail = await platformUserDetail(String(req.params.userId));
  if (!detail) return res.status(404).json({ error: "user not found" });
  res.json(detail);
});

router.get("/subscriptions", requirePlatform("subscriptions:read"), async (req: PlatformRequest, res: Response) => {
  res.json(await listPlatformSubscriptions(req.query));
});

router.get("/payments", requirePlatform("payments:read"), async (req: PlatformRequest, res: Response) => {
  res.json(await listPlatformPayments({ status: req.query.status, cursor: req.query.cursor, limit: req.query.limit }));
});

export default router;
