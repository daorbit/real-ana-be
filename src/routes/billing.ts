import { Router, Response } from "express";
import { Plan } from "../models/Plan.js";
import { AddonPack } from "../models/AddonPack.js";
import { Subscription } from "../models/Subscription.js";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { User } from "../models/User.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";
import {
  razorpay,
  razorpayConfigured,
  verifySubscriptionPayment,
  verifyOrderPayment,
} from "../lib/razorpay.js";
import { quotaSummary } from "../lib/quota.js";

/**
 * Subscription plans, addon packs, and the checkout flow that sells both
 * through Razorpay. Mounted at `/api/billing`.
 *
 * The catalogue reads (`/plans`, `/addons`) are open to any signed-in user;
 * everything that starts money moving requires auth, and writes are blocked
 * in demo mode like the rest of the dashboard API.
 */
const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

/* --------------------------------- catalogue -------------------------------- */

router.get("/plans", async (_req: AuthedRequest, res: Response) => {
  const plans = await Plan.find({ active: true }).sort({ sortOrder: 1 });
  res.json(plans);
});

router.get("/addons", async (_req: AuthedRequest, res: Response) => {
  const addons = await AddonPack.find({ active: true }).sort({ sortOrder: 1 });
  res.json(addons);
});

/** The caller's current subscription and this cycle's usage, or null if never subscribed. */
router.get("/me", async (req: AuthedRequest, res: Response) => {
  const summary = await quotaSummary(req.userId as string);
  res.json(summary);
});

/* -------------------------------- subscribe --------------------------------- */

/**
 * Start (or switch) a subscription: creates a Razorpay Customer if the user
 * doesn't have one yet, then a Razorpay Subscription against the chosen
 * plan+cycle's Razorpay plan id. The client completes payment with Razorpay
 * Checkout using the returned `subscriptionId`, then calls `/subscribe/verify`.
 */
router.post("/subscribe", async (req: AuthedRequest, res: Response) => {
  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  const planId = String(req.body?.planId ?? "");
  const cycle = req.body?.cycle === "yearly" ? "yearly" : "monthly";

  const plan = await Plan.findOne({ _id: planId, active: true });
  if (!plan) return res.status(404).json({ error: "plan not found" });

  const rzpPlanId = cycle === "yearly" ? plan.razorpayPlanIdYearly : plan.razorpayPlanIdMonthly;
  if (!rzpPlanId)
    return res.status(400).json({ error: `plan has no Razorpay ${cycle} price configured` });

  const user = await User.findById(req.userId).select("email name");
  if (!user) return res.status(404).json({ error: "user not found" });

  let sub = await Subscription.findOne({ userId: req.userId });

  try {
    let customerId = sub?.razorpayCustomerId || "";
    if (!customerId) {
      const customer = await razorpay().customers.create({
        name: user.name,
        email: user.email,
        fail_existing: 0,
      } as never);
      customerId = customer.id;
    }

    const rzpSub = await razorpay().subscriptions.create({
      plan_id: rzpPlanId,
      customer_notify: 1,
      total_count: cycle === "yearly" ? 1 : 12,
      notes: { userId: String(req.userId), planId: String(plan.id), cycle },
    } as never);

    if (sub) {
      sub.set({
        planId: plan.id,
        cycle,
        razorpaySubscriptionId: rzpSub.id,
        razorpayCustomerId: customerId,
        status: "created",
      });
      await sub.save();
    } else {
      sub = await Subscription.create({
        userId: req.userId,
        planId: plan.id,
        cycle,
        razorpaySubscriptionId: rzpSub.id,
        razorpayCustomerId: customerId,
        status: "created",
      });
    }

    res.json({
      subscriptionId: rzpSub.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      plan: { name: plan.name, cycle },
    });
  } catch (e) {
    console.error("Razorpay subscribe failed:", (e as Error).message);
    res.status(502).json({ error: "could not start checkout with Razorpay" });
  }
});

/**
 * Confirm a subscription checkout client-side, as a fast path to unlock the
 * account immediately — the webhook is still the source of truth and will
 * reconcile `status`/`currentPeriodEnd` moments later regardless.
 */
router.post("/subscribe/verify", async (req: AuthedRequest, res: Response) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body ?? {};
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature)
    return res.status(400).json({ error: "missing verification fields" });

  const ok = verifySubscriptionPayment({
    subscriptionId: String(razorpay_subscription_id),
    paymentId: String(razorpay_payment_id),
    signature: String(razorpay_signature),
  });
  if (!ok) return res.status(400).json({ error: "signature mismatch" });

  const sub = await Subscription.findOne({
    userId: req.userId,
    razorpaySubscriptionId: razorpay_subscription_id,
  });
  if (!sub) return res.status(404).json({ error: "subscription not found" });

  sub.set({ status: "active" });
  await sub.save();
  res.json({ ok: true });
});

/** Cancel at the end of the current period — no refund, access continues until then. */
router.post("/cancel", async (req: AuthedRequest, res: Response) => {
  const sub = await Subscription.findOne({ userId: req.userId });
  if (!sub || !sub.razorpaySubscriptionId)
    return res.status(404).json({ error: "no active subscription" });

  try {
    await razorpay().subscriptions.cancel(sub.razorpaySubscriptionId as string, true);
    sub.set({ cancelAtPeriodEnd: true });
    await sub.save();
    res.json({ ok: true });
  } catch (e) {
    console.error("Razorpay cancel failed:", (e as Error).message);
    res.status(502).json({ error: "could not cancel with Razorpay" });
  }
});

/* ---------------------------------- addons ----------------------------------- */

/** Start checkout for a one-time addon credit pack. */
router.post("/addons/:slug/purchase", async (req: AuthedRequest, res: Response) => {
  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  const pack = await AddonPack.findOne({ slug: req.params.slug, active: true });
  if (!pack) return res.status(404).json({ error: "addon not found" });

  try {
    const order = await razorpay().orders.create({
      amount: pack.price,
      currency: "INR",
      notes: { userId: String(req.userId), addonPackId: String(pack.id) },
    });

    await AddonPurchase.create({
      userId: req.userId,
      addonPackId: pack.id,
      razorpayOrderId: order.id,
      amount: pack.price,
      status: "created",
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      addon: { name: pack.name, type: pack.type, quantity: pack.quantity },
    });
  } catch (e) {
    console.error("Razorpay order failed:", (e as Error).message);
    res.status(502).json({ error: "could not start checkout with Razorpay" });
  }
});

/** Confirm an addon purchase client-side; the webhook also credits it independently and idempotently. */
router.post("/addons/verify", async (req: AuthedRequest, res: Response) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body ?? {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature)
    return res.status(400).json({ error: "missing verification fields" });

  const ok = verifyOrderPayment({
    orderId: String(razorpay_order_id),
    paymentId: String(razorpay_payment_id),
    signature: String(razorpay_signature),
  });
  if (!ok) return res.status(400).json({ error: "signature mismatch" });

  const purchase = await AddonPurchase.findOne({
    userId: req.userId,
    razorpayOrderId: razorpay_order_id,
  });
  if (!purchase) return res.status(404).json({ error: "purchase not found" });

  await creditAddonPurchase(purchase.id, String(razorpay_payment_id));
  res.json({ ok: true });
});

/**
 * Credit an addon purchase's pack quantity onto the user's subscription.
 * Idempotent on `purchase.status`, so the client-side verify call and the
 * webhook racing each other credits the user exactly once.
 *
 * Exported for the webhook route, which credits the same purchase on
 * `order.paid` independently of this router's own verify endpoint.
 */
export async function creditAddonPurchase(purchaseId: string, paymentId: string) {
  const purchase = await AddonPurchase.findById(purchaseId);
  if (!purchase || purchase.status === "paid") return;

  const pack = await AddonPack.findById(purchase.addonPackId);
  if (!pack) return;

  const field = pack.type === "audit" ? "addonAuditCredits" : "addonCrawlCredits";
  await Subscription.updateOne(
    { userId: purchase.userId },
    { $inc: { [field]: pack.quantity } }
  );

  purchase.set({ status: "paid", razorpayPaymentId: paymentId });
  await purchase.save();
}

export default router;
