import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { ensureReferralCode } from "../../modules/referrals/codes.js";
import { getReferralSettings } from "../../modules/referrals/settings.js";
import { claimReferral } from "../../modules/referrals/referral.service.js";
import { myReferralSummary } from "../../modules/referrals/referral-admin.service.js";
import { clientIp } from "../../modules/analytics/enrich.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

router.get("/me", async (req: AuthedRequest, res: Response) => {
  if (req.isDemo) return res.json({ enabled: false, code: null, active: false, referrals: [] });

  const settings = await getReferralSettings();
  const [code, referrals] = await Promise.all([
    settings.enabled ? ensureReferralCode(req.userId as string) : null,
    myReferralSummary(req.userId as string),
  ]);

  res.json({
    enabled: settings.enabled,
    code: code?.code ?? null,
    active: Boolean(code?.active),
    qualifyOn: settings.qualifyOn,
    rewardPercentOff: settings.rewardPercentOff,
    rewardValidDays: settings.rewardValidDays,
    referrals,
  });
});

router.post("/claim", async (req: AuthedRequest, res: Response) => {
  if (req.impersonatorId) return res.status(403).json({ error: "not available while impersonating" });
  const result = await claimReferral(req.userId as string, req.body?.code, clientIp(req));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

export default router;
