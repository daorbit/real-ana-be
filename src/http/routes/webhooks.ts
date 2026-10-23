import { Router, Request, Response } from "express";
import { AddonPurchase } from "../../modules/billing/models/AddonPurchase.js";
import { PlanPurchase } from "../../modules/billing/models/PlanPurchase.js";
import { verifyWebhookSignature } from "../../infra/payments/razorpay.js";
import { verifyCashfreeWebhook } from "../../infra/payments/cashfree.js";
import { creditAddonPurchase, creditPlanPurchase, creditSubscriptionPayment } from "./billing.js";
import {
  adoptSubscription,
  paidUpfrontPayment,
  subscriptionMeta,
  updateRenewalStatus,
  type RazorpaySubscriptionEntity,
} from "../../modules/billing/auto-renew.js";
import { Subscription, type RenewalStatus } from "../../modules/billing/models/Subscription.js";
import { emit } from "../../modules/notifications/notify.service.js";

const SUBSCRIPTION_STATUS_EVENTS: Record<string, RenewalStatus> = {
  "subscription.activated": "active",
  "subscription.pending": "pending",
  "subscription.halted": "halted",
  "subscription.cancelled": "cancelled",
  "subscription.completed": "completed",
};

const RENEWAL_FAILURE_REASON: Partial<Record<RenewalStatus, string>> = {
  pending: "the automatic renewal was declined, and Razorpay will retry it",
  halted: "auto-renew stopped after repeated failed charges",
};

async function notifyRenewalFailed(entity: RazorpaySubscriptionEntity, status: RenewalStatus) {
  const reason = RENEWAL_FAILURE_REASON[status];
  if (!reason) return;
  const sub = await Subscription.findOne({ razorpaySubscriptionId: entity.id }).select("workspaceId").lean();
  if (!sub?.workspaceId) return;
  await emit({
    type: "payment.failed",
    workspaceId: String(sub.workspaceId),
    data: { reason },
    link: "/app/billing",
  });
}

async function handleSubscriptionEvent(event: {
  event: string;
  payload?: { subscription?: { entity?: RazorpaySubscriptionEntity }; payment?: { entity?: { id?: string; amount?: number; currency?: string } } };
}) {
  const entity = event.payload?.subscription?.entity;
  if (!entity?.id) return;
  const payment = event.payload?.payment?.entity;

  if (event.event === "subscription.charged") {
    if (!payment?.id) return;
    await creditSubscriptionPayment(entity, {
      id: payment.id,
      amount: Number(payment.amount ?? 0),
      currency: String(payment.currency ?? "INR"),
    });
    return;
  }

  if (event.event === "subscription.authenticated") {
    const meta = subscriptionMeta(entity);
    if (!meta) return;
    const upfront = await paidUpfrontPayment(entity.id).catch(() => null);
    if (upfront) await creditSubscriptionPayment(entity, upfront);
    else await adoptSubscription(meta.workspaceId, entity, "authenticated");
    return;
  }

  const status = SUBSCRIPTION_STATUS_EVENTS[event.event];
  if (!status) return;
  await updateRenewalStatus(entity, status);
  await notifyRenewalFailed(entity, status);
}

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
    if (event.event === "order.paid") {
      const payload = event.payload.order.entity;
      const payment = event.payload.payment?.entity;

      const addonPurchase = await AddonPurchase.findOne({ razorpayOrderId: payload.id });
      if (addonPurchase) await creditAddonPurchase(addonPurchase.id, payment?.id ?? "");

      const planPurchase = await PlanPurchase.findOne({ razorpayOrderId: payload.id });
      if (planPurchase) await creditPlanPurchase(planPurchase.id, payment?.id ?? "");
    } else if (String(event.event).startsWith("subscription.")) {
      await handleSubscriptionEvent(event);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Webhook handling failed:", event.event, (e as Error).message);
    // Acknowledge anyway — Razorpay retries on non-2xx, and a bug in our
    // handling shouldn't turn into an indefinite retry storm from their side.
    res.json({ ok: true });
  }
});

/**
 * Cashfree webhook, configured against `/api/webhooks/cashfree`. Mounted with
 * `express.raw` in app.ts for the same signing reason as Razorpay's.
 *
 * Cashfree signs `x-webhook-timestamp + rawBody` with HMAC-SHA256 keyed on the
 * secret key (no separate webhook secret), base64, in `x-webhook-signature`.
 *
 * Only the success event matters here — the purchase row is credited the same
 * idempotent way as the client-side verify call, so a redelivery is harmless.
 * The order id we set at checkout is echoed back as `data.order.order_id`.
 */
router.post("/cashfree", async (req: Request, res: Response) => {
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  const rawBody = (req.body as Buffer)?.toString("utf8") ?? "";

  if (
    typeof signature !== "string" ||
    typeof timestamp !== "string" ||
    !verifyCashfreeWebhook(rawBody, signature, timestamp)
  ) {
    return res.status(400).json({ error: "invalid signature" });
  }

  const event = JSON.parse(rawBody);

  try {
    if (event.type === "PAYMENT_SUCCESS_WEBHOOK") {
      const orderId: string = event.data?.order?.order_id ?? "";
      const paymentId = String(event.data?.payment?.cf_payment_id ?? "");

      if (orderId) {
        const addonPurchase = await AddonPurchase.findOne({ cashfreeOrderId: orderId });
        if (addonPurchase) await creditAddonPurchase(addonPurchase.id, paymentId);

        const planPurchase = await PlanPurchase.findOne({ cashfreeOrderId: orderId });
        if (planPurchase) await creditPlanPurchase(planPurchase.id, paymentId);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Cashfree webhook handling failed:", event.type, (e as Error).message);
    // Acknowledged regardless, same reasoning as the Razorpay handler.
    res.json({ ok: true });
  }
});

export default router;
