import { Router, Response } from "express";
import { AddonPack } from "../models/AddonPack.js";
import { Subscription, type BillingCycle } from "../models/Subscription.js";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { PlanPurchase } from "../models/PlanPurchase.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";
import { razorpay, razorpayConfigured, verifyOrderPayment } from "../lib/razorpay.js";
import { quotaSummary } from "../lib/quota.js";
import { listResolvedPlans, getResolvedPlan } from "../lib/planPricing.js";

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
  res.json(await listResolvedPlans());
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

const CYCLE_DAYS: Record<BillingCycle, number> = { monthly: 30, yearly: 365 };

/**
 * Start checkout for a plan period: a one-time Razorpay Order, not a
 * recurring Subscription — there is no auto-charge on renewal. The client
 * completes payment with Razorpay Checkout using the returned `orderId`, then
 * calls `/subscribe/verify`. Buying again after the period ends (or early, to
 * switch plans) is how renewal works.
 */
router.post("/subscribe", async (req: AuthedRequest, res: Response) => {
  const planSlug = String(req.body?.planSlug ?? "");
  const cycle: BillingCycle = req.body?.cycle === "yearly" ? "yearly" : "monthly";

  const plan = await getResolvedPlan(planSlug);
  if (!plan) return res.status(404).json({ error: "plan not found" });

  const amount = cycle === "yearly" ? plan.priceYearly : plan.priceMonthly;

  // Free has no charge to make — assign it directly rather than round-tripping
  // through Razorpay for a ₹0 order.
  if (amount === 0) {
    await activatePlanPeriod(req.userId as string, plan.slug, cycle);
    return res.json({ free: true, plan: { name: plan.name, cycle } });
  }

  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  try {
    const order = await razorpay().orders.create({
      amount,
      currency: "INR",
      notes: { userId: String(req.userId), planSlug: plan.slug, cycle },
    });

    await PlanPurchase.create({
      userId: req.userId,
      planSlug: plan.slug,
      cycle,
      razorpayOrderId: order.id,
      amount,
      status: "created",
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      plan: { name: plan.name, cycle },
    });
  } catch (e) {
    console.error("Razorpay order failed:", (e as Error).message);
    res.status(502).json({ error: "could not start checkout with Razorpay" });
  }
});

/** Confirm a plan purchase client-side; the webhook also activates it independently and idempotently. */
router.post("/subscribe/verify", async (req: AuthedRequest, res: Response) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body ?? {};
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature)
    return res.status(400).json({ error: "missing verification fields" });

  const ok = verifyOrderPayment({
    orderId: String(razorpay_order_id),
    paymentId: String(razorpay_payment_id),
    signature: String(razorpay_signature),
  });
  if (!ok) return res.status(400).json({ error: "signature mismatch" });

  const purchase = await PlanPurchase.findOne({
    userId: req.userId,
    razorpayOrderId: razorpay_order_id,
  });
  if (!purchase) return res.status(404).json({ error: "purchase not found" });

  await creditPlanPurchase(purchase.id, String(razorpay_payment_id));
  res.json({ ok: true });
});

/**
 * Put a user on a plan for one billing period starting now. Shared by the
 * free-plan fast path above and by `creditPlanPurchase` once a paid order is
 * confirmed — both just decide the period, this applies it.
 *
 * Switching plans (not just renewing the same one) resets usage too: the new
 * plan's quota starts from zero rather than inheriting whatever was used
 * against the old one this cycle.
 */
async function activatePlanPeriod(userId: string, planSlug: string, cycle: BillingCycle) {
  const now = new Date();
  const periodEnd = new Date(now.getTime() + CYCLE_DAYS[cycle] * 24 * 60 * 60 * 1000);
  await Subscription.findOneAndUpdate(
    { userId },
    {
      $set: {
        planSlug,
        cycle,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        auditsUsed: 0,
        crawlsUsed: 0,
      },
    },
    { upsert: true }
  );
}

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

/**
 * Activate the plan period a `PlanPurchase` paid for. Idempotent on
 * `purchase.status`, same guard as `creditAddonPurchase` — the client-side
 * verify call and the webhook can both race to call this for the same order.
 *
 * Exported for the webhook route, which activates the same purchase on
 * `order.paid` independently of this router's own verify endpoint.
 */
export async function creditPlanPurchase(purchaseId: string, paymentId: string) {
  const purchase = await PlanPurchase.findById(purchaseId);
  if (!purchase || purchase.status === "paid") return;

  await activatePlanPeriod(
    String(purchase.userId),
    purchase.planSlug as string,
    purchase.cycle as BillingCycle
  );

  purchase.set({ status: "paid", razorpayPaymentId: paymentId });
  await purchase.save();
}

export default router;
