import { Router, type Response } from "express";
import { requirePlatform, type PlatformRequest } from "../middleware/platform-auth.js";
import { PLATFORM_AUDIENCE } from "../../modules/platform/platform-token.js";
import { databaseHealth, metricsSummary, readRange } from "../../modules/platform/metrics.service.js";
import { listPlatformPayments } from "../../modules/platform/payments.service.js";
import { listPlatformSubscriptions } from "../../modules/platform/subscriptions.service.js";
import { listPlatformUsers, platformUserDetail } from "../../modules/platform/users.service.js";
import { changeUserRole } from "../../modules/admin/user-role.service.js";
import { User } from "../../modules/identity/models/User.js";
import { signImpersonationHandoff } from "../../modules/platform/impersonation-handoff.js";
import {
  deleteUserAsAdmin,
  disableUserTwoFactor,
  grantWorkspaceSiteSlot,
  isAccountStatus,
  isAudience,
  resetUserScreenLock,
  setUserAudience,
  setUserStatus,
} from "../../modules/admin/user-actions.service.js";

const router = Router();

const CAPABILITIES = ["users", "billing", "payments", "metrics", "health", "user-actions"];
const PLATFORM_ROLES = ["user", "admin"] as const;

function actorOf(req: PlatformRequest): string {
  return `platform:${req.platformAdmin?.email ?? "unknown"}`;
}

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

router.post("/users/:userId/two-factor/reset", requirePlatform("users:suspend"), async (req: PlatformRequest, res: Response) => {
  res.json(await disableUserTwoFactor(String(req.params.userId), actorOf(req)));
});

router.post("/users/:userId/screen-lock/reset", requirePlatform("users:suspend"), async (req: PlatformRequest, res: Response) => {
  res.json(await resetUserScreenLock(String(req.params.userId), actorOf(req)));
});

router.put("/users/:userId/audience", requirePlatform("users:roles"), async (req: PlatformRequest, res: Response) => {
  const audience = req.body?.audience;
  if (!isAudience(audience)) return res.status(400).json({ error: "audience must be internal or external" });
  res.json(await setUserAudience(String(req.params.userId), audience, actorOf(req)));
});

router.post("/users/:userId/impersonation", requirePlatform("users:impersonate"), async (req: PlatformRequest, res: Response) => {
  const target = await User.findById(String(req.params.userId)).select("email role");
  if (!target) return res.status(404).json({ error: "user not found" });
  if (target.role === "super_admin") return res.status(400).json({ error: "cannot open the super admin's account" });

  const code = signImpersonationHandoff(target.id, req.platformAdmin?.email ?? "unknown");
  const origin = `${req.protocol}://${req.get("host")}`;
  console.log(`[platform] ${actorOf(req)} requested a sign-in link for ${target.id} (${target.email})`);
  res.json({ url: `${origin}/api/auth/impersonation/handoff?code=${encodeURIComponent(code)}`, expiresInSeconds: 60 });
});

router.put("/users/:userId/status", requirePlatform("users:suspend"), async (req: PlatformRequest, res: Response) => {
  const status = req.body?.status;
  if (!isAccountStatus(status)) return res.status(400).json({ error: "status must be active or suspended" });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  res.json(await setUserStatus(String(req.params.userId), status, reason, actorOf(req)));
});

router.put("/users/:userId/role", requirePlatform("users:roles"), async (req: PlatformRequest, res: Response) => {
  const role = req.body?.role;
  if (!(PLATFORM_ROLES as readonly string[]).includes(role)) {
    return res.status(400).json({ error: "role must be user or admin. Grant super admin from Quantalog itself." });
  }
  const change = await changeUserRole(actorOf(req), String(req.params.userId), role);
  if (change.previousRole !== change.role) {
    console.log(`[platform] ${actorOf(req)} changed ${change.id} (${change.email}) from ${change.previousRole} to ${change.role}`);
  }
  res.json(change);
});

router.delete("/users/:userId", requirePlatform("users:delete"), async (req: PlatformRequest, res: Response) => {
  res.json(await deleteUserAsAdmin(String(req.params.userId), actorOf(req)));
});

router.post("/workspaces/:workspaceId/site-slots", requirePlatform("subscriptions:extend"), async (req: PlatformRequest, res: Response) => {
  res.json(await grantWorkspaceSiteSlot(String(req.params.workspaceId), actorOf(req)));
});

router.get("/subscriptions", requirePlatform("subscriptions:read"), async (req: PlatformRequest, res: Response) => {
  res.json(await listPlatformSubscriptions(req.query));
});

router.get("/payments", requirePlatform("payments:read"), async (req: PlatformRequest, res: Response) => {
  res.json(await listPlatformPayments({ status: req.query.status, cursor: req.query.cursor, limit: req.query.limit }));
});

export default router;
