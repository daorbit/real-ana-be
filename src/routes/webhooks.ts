import { Router, Request, Response } from "express";
import { Subscription } from "../models/Subscription.js";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { verifyWebhookSignature } from "../lib/razorpay.js";
import { creditAddonPurchase } from "./billing.js";

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
 */
router.post("/razorpay", async (req: Request, res: Response) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = (req.body as Buffer)?.toString("utf8") ?? "";

  if (typeof signature !== "string" || !verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: "invalid signature" });
  }

  const event = JSON.parse(rawBody);

  try {
    switch (event.event) {
      case "subscription.activated":
      case "subscription.charged": {
        const payload = event.payload.subscription.entity;
        const sub = await Subscription.findOne({ razorpaySubscriptionId: payload.id });
        if (sub) {
          const periodStart = payload.current_start ? new Date(payload.current_start * 1000) : null;
          const periodEnd = payload.current_end ? new Date(payload.current_end * 1000) : null;
          // A new billing period started: reset this cycle's plan usage.
          // Addon credits are untouched — those persist until spent.
          const isNewPeriod =
            periodStart && (!sub.currentPeriodStart || periodStart > sub.currentPeriodStart);
          sub.set({
            status: "active",
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            ...(isNewPeriod ? { auditsUsed: 0, crawlsUsed: 0 } : {}),
          });
          await sub.save();
        }
        break;
      }
      case "subscription.pending":
      case "subscription.halted": {
        const payload = event.payload.subscription.entity;
        await Subscription.updateOne(
          { razorpaySubscriptionId: payload.id },
          { $set: { status: "past_due" } }
        );
        break;
      }
      case "subscription.cancelled":
      case "subscription.completed": {
        const payload = event.payload.subscription.entity;
        await Subscription.updateOne(
          { razorpaySubscriptionId: payload.id },
          { $set: { status: "cancelled" } }
        );
        break;
      }
      case "order.paid": {
        const payload = event.payload.order.entity;
        const payment = event.payload.payment?.entity;
        const purchase = await AddonPurchase.findOne({ razorpayOrderId: payload.id });
        if (purchase) await creditAddonPurchase(purchase.id, payment?.id ?? "");
        break;
      }
      default:
        break;
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
