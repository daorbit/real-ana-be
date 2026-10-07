import { Router, Response } from "express";
import mongoose from "mongoose";
import { requireAuth, requireSuperAdmin, AuthedRequest } from "../middleware/auth.js";
import { getReferralSettings, setReferralSettings } from "../../modules/referrals/settings.js";
import { rewardReferral } from "../../modules/referrals/referral.service.js";
import {
  listReferrals,
  referralOverview,
  topReferrers,
  rejectReferral,
  revokeReferral,
  setCodeActive,
} from "../../modules/referrals/referral-admin.service.js";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

router.get("/settings", async (_req: AuthedRequest, res: Response) => {
  res.json(await getReferralSettings());
});

router.put("/settings", async (req: AuthedRequest, res: Response) => {
  const settings = await setReferralSettings(req.body);
  console.log(`[admin] ${req.userId} updated referral settings`, settings);
  res.json(settings);
});

router.get("/overview", async (_req: AuthedRequest, res: Response) => {
  res.json(await referralOverview());
});

router.get("/top", async (_req: AuthedRequest, res: Response) => {
  res.json({ referrers: await topReferrers() });
});

router.get("/", async (req: AuthedRequest, res: Response) => {
  res.json(
    await listReferrals({
      q: String(req.query.q ?? ""),
      status: String(req.query.status ?? ""),
      page: Number(req.query.page) || 1,
    }),
  );
});

router.post("/:id/reward", async (req: AuthedRequest, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "referral not found" });
  const result = await rewardReferral(String(req.params.id), { bypassCap: true });
  if (!result.ok) return res.status(400).json({ error: result.error });
  console.log(`[admin] ${req.userId} rewarded referral ${req.params.id} (${result.couponCode})`);
  res.json(result);
});

router.post("/:id/reject", async (req: AuthedRequest, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "referral not found" });
  const result = await rejectReferral(String(req.params.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  console.log(`[admin] ${req.userId} rejected referral ${req.params.id}`);
  res.json(result);
});

router.post("/:id/revoke", async (req: AuthedRequest, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "referral not found" });
  const result = await revokeReferral(String(req.params.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  console.log(`[admin] ${req.userId} revoked referral ${req.params.id}`);
  res.json(result);
});

router.put("/codes/:userId", async (req: AuthedRequest, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.userId)) return res.status(404).json({ error: "user not found" });
  const result = await setCodeActive(String(req.params.userId), req.body?.active !== false);
  if (!result.ok) return res.status(404).json({ error: result.error });
  console.log(`[admin] ${req.userId} set referral code of ${req.params.userId} active=${result.active}`);
  res.json(result);
});

export default router;
