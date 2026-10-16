import { Router, Request, Response } from "express";
import { safeEqual } from "../../shared/utils/crypto-box.js";
import { captureServerError } from "../../infra/monitoring/sentry.js";
import { platformWebhookSecret } from "../../infra/messaging/telegram.js";
import { handleUpdate } from "../../modules/telegram/telegram-updates.js";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const secret = platformWebhookSecret() ?? "";
  const given = String(req.get("x-telegram-bot-api-secret-token") ?? "");
  if (!secret || !safeEqual(given, secret)) return res.status(401).json({ error: "unauthorized" });

  try {
    await handleUpdate(req.body ?? {});
  } catch (e) {
    void captureServerError(e, { method: req.method, path: req.originalUrl });
  }
  res.json({ ok: true });
});

export default router;
