import { Router, Request, Response } from "express";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { PlanPurchase } from "../models/PlanPurchase.js";
import { verifyWebhookSignature } from "../lib/razorpay.js";
import { creditAddonPurchase, creditPlanPurchase } from "./billing.js";

/**
 * Inbound webhooks from third parties. Unauthenticated by design — the
 * signature check is the credential — so this stays off the dashboard CORS
 * allowlist and off `requireAuth` entirely.
 */
const router = Router();

/**
 * Razorpay webhook, configured in the Razorpay dashboard against
 * `/api/webhooks/razorpay`. Mounted with `express.raw` in app.ts (not the
 * global JSON parser) because signature verification needs the exact bytes
 * Razorpay signed — a body that has been parsed and re-serialised is not
 * guaranteed to match byte-for-byte.
 *
 * Only `order.paid` matters here — plans and addon packs are both bought as
 * one-time Orders, not Razorpay Subscriptions, so there's no recurring-billing
 * lifecycle to track.
 */
router.post("/razorpay", async (req: Request, res: Response) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = (req.body as Buffer)?.toString("utf8") ?? "";

  if (typeof signature !== "string" || !verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: "invalid signature" });
  }

  const event = JSON.parse(rawBody);

  try {
    if (event.event === "order.paid") {
      const payload = event.payload.order.entity;
      const payment = event.payload.payment?.entity;

      const addonPurchase = await AddonPurchase.findOne({ razorpayOrderId: payload.id });
      if (addonPurchase) await creditAddonPurchase(addonPurchase.id, payment?.id ?? "");

      const planPurchase = await PlanPurchase.findOne({ razorpayOrderId: payload.id });
      if (planPurchase) await creditPlanPurchase(planPurchase.id, payment?.id ?? "");
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Webhook handling failed:", event.event, (e as Error).message);
    // Acknowledge anyway — Razorpay retries on non-2xx, and a bug in our
    // handling shouldn't turn into an indefinite retry storm from their side.
    res.json({ ok: true });
  }
});

export default router;
