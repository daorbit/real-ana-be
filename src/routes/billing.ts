import { Router, Response } from "express";
import { AddonPack } from "../models/AddonPack.js";
import { Subscription, type BillingCycle } from "../models/Subscription.js";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { PlanPurchase } from "../models/PlanPurchase.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";
import { razorpay, razorpayConfigured, verifyOrderPayment } from "../lib/razorpay.js";
import { activatePlanPeriod } from "../lib/quota.js";
import { listResolvedPlans, getResolvedPlan } from "../lib/planPricing.js";
import { applyCoupon } from "../lib/coupons.js";
import { resolveCurrency } from "../lib/currency.js";
import { User } from "../models/User.js";
import {
  buildInvoice,
  nextInvoiceNumber,
  renderInvoicePdf,
  formatAmount,
  type InvoiceKind,
} from "../lib/invoice.js";
import { sendInvoiceEmail, mailConfigured } from "../lib/mail.js";

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

/**
 * Preview a coupon against a known amount before checkout starts — lets the
 * client show "20% off — ₹799" as someone types a code, rather than only
 * finding out it's invalid after Razorpay Checkout has already opened.
 */
router.post("/coupons/check", async (req: AuthedRequest, res: Response) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 0)
    return res.status(400).json({ error: "amount must be a non-negative number" });

  const result = await applyCoupon(amount, req.body?.code);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

/* -------------------------------- subscribe --------------------------------- */

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
  const currency = resolveCurrency(req.body?.currency);

  const plan = await getResolvedPlan(planSlug);
  if (!plan) return res.status(404).json({ error: "plan not found" });

  const listPrice = (cycle === "yearly" ? plan.priceYearly : plan.priceMonthly)[currency];
  const discounted = await applyCoupon(listPrice, req.body?.couponCode);
  if (discounted.error) return res.status(400).json({ error: discounted.error });
  const amount = discounted.amount;

  // Free has no charge to make — assign it directly rather than round-tripping
  // through Razorpay for a ₹0/$0/€0 order. A coupon can also discount a paid
  // plan to 0, which takes the same free path.
  if (amount === 0) {
    await activatePlanPeriod(req.userId as string, plan.slug, cycle);
    return res.json({ free: true, plan: { name: plan.name, cycle } });
  }

  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  try {
    const order = await razorpay().orders.create({
      amount,
      currency,
      notes: { userId: String(req.userId), planSlug: plan.slug, cycle },
    });

    await PlanPurchase.create({
      userId: req.userId,
      planSlug: plan.slug,
      cycle,
      razorpayOrderId: order.id,
      amount,
      currency,
      couponCode: discounted.coupon?.code ?? "",
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

/* ---------------------------------- addons ----------------------------------- */

/** Start checkout for a one-time addon credit pack. */
router.post("/addons/:slug/purchase", async (req: AuthedRequest, res: Response) => {
  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  const pack = await AddonPack.findOne({ slug: req.params.slug, active: true });
  if (!pack) return res.status(404).json({ error: "addon not found" });

  const currency = resolveCurrency(req.body?.currency);
  const price = (pack.price as unknown as Record<string, number>)[currency] ?? 0;
  const discounted = await applyCoupon(price, req.body?.couponCode);
  if (discounted.error) return res.status(400).json({ error: discounted.error });

  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  try {
    // Razorpay Orders don't accept a 0 amount — a coupon big enough to zero
    // out an addon still needs a real (if tiny) charge, unlike a free plan
    // there's no "just activate it" path for credits.
    const amount = Math.max(discounted.amount, 100);

    const order = await razorpay().orders.create({
      amount,
      currency,
      notes: { userId: String(req.userId), addonPackId: String(pack.id) },
    });

    await AddonPurchase.create({
      userId: req.userId,
      addonPackId: pack.id,
      razorpayOrderId: order.id,
      amount,
      currency,
      couponCode: discounted.coupon?.code ?? "",
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
  // Atomically claim the purchase before crediting anything — the
  // client-side verify call and the webhook can call this for the same
  // order at nearly the same instant, and a plain find-then-check-then-save
  // lets both pass the "not yet paid" check before either writes, crediting
  // the user twice. Only the caller whose update actually flips the status
  // proceeds to credit.
  const purchase = await AddonPurchase.findOneAndUpdate(
    { _id: purchaseId, status: { $ne: "paid" } },
    { $set: { status: "paid", razorpayPaymentId: paymentId } },
  );
  if (!purchase) return;

  const pack = await AddonPack.findById(purchase.addonPackId);
  if (!pack) return;

  const field = pack.type === "audit" ? "addonAuditCredits" : "addonCrawlCredits";
  await Subscription.updateOne(
    { userId: purchase.userId },
    { $inc: { [field]: pack.quantity } }
  );

  await issueReceipt("addon", purchase.id, String(purchase.userId));
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
  // Same atomic-claim pattern as `creditAddonPurchase` — see its comment.
  const purchase = await PlanPurchase.findOneAndUpdate(
    { _id: purchaseId, status: { $ne: "paid" } },
    { $set: { status: "paid", razorpayPaymentId: paymentId } },
  );
  if (!purchase) return;

  await activatePlanPeriod(
    String(purchase.userId),
    purchase.planSlug as string,
    purchase.cycle as BillingCycle
  );

  await issueReceipt("plan", purchase.id, String(purchase.userId));
}

/* -------------------------------- receipts ---------------------------------- */

/**
 * Assign a receipt number to a freshly credited purchase and email the PDF.
 *
 * Called from inside the credit functions, after the credit itself has landed,
 * and swallows every failure: the money has already moved and the account has
 * already been upgraded by this point, so a bounced email or a PDF that failed
 * to render must not propagate into the webhook or the verify response and
 * suggest the purchase didn't work. The receipt is regenerable from the
 * dashboard, an unactivated paid plan is not.
 *
 * Reached only through the credit path's atomic status claim, so it runs once
 * per purchase even when the webhook and the client-side verify call race.
 */
async function issueReceipt(kind: InvoiceKind, purchaseId: string, userId: string) {
  try {
    const issuedAt = new Date();
    const number = await nextInvoiceNumber(issuedAt);

    // Guard on the number being unset so a re-credit attempt can't renumber a
    // receipt the buyer already has in their inbox.
    const filter = { _id: purchaseId, $or: [{ invoiceNumber: "" }, { invoiceNumber: null }] };
    const update = { $set: { invoiceNumber: number, invoicedAt: issuedAt } };

    // Branching on the model rather than holding one in a variable: the two
    // schemas give `findOneAndUpdate` incompatible signatures, so a union-typed
    // handle isn't callable.
    const claimed =
      kind === "plan"
        ? await PlanPurchase.findOneAndUpdate(filter, update)
        : await AddonPurchase.findOneAndUpdate(filter, update);
    if (!claimed) return;

    if (!mailConfigured()) return;

    const user = await User.findById(userId).select("name email");
    if (!user?.email) return;

    const invoice = await buildInvoice(kind, purchaseId, userId, {
      name: (user.name as string) ?? "",
      email: user.email as string,
    });
    if (!invoice) return;

    const pdf = await renderInvoicePdf(invoice);

    await sendInvoiceEmail(
      { email: invoice.buyer.email, name: invoice.buyer.name },
      {
        number: invoice.number,
        description: invoice.description,
        amountLabel: formatAmount(invoice.amount, invoice.currency),
        paymentId: invoice.paymentId,
        dateLabel: invoice.issuedAt.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }),
      },
      pdf,
    );
  } catch (e) {
    console.error("Receipt issuance failed:", kind, purchaseId, (e as Error).message);
  }
}

/**
 * The buyer's own receipts, newest first.
 *
 * Plans and addons live in separate collections but are one history to the
 * person reading it, so they're merged here rather than exposed as two lists
 * the client would have to interleave itself. Only paid rows with a number
 * appear — an abandoned checkout is not a purchase.
 */
router.get("/invoices", async (req: AuthedRequest, res: Response) => {
  const query = {
    userId: req.userId,
    status: "paid" as const,
    invoiceNumber: { $nin: ["", null] },
  };

  const [plans, addons] = await Promise.all([
    PlanPurchase.find(query).sort({ invoicedAt: -1 }).limit(100).lean(),
    AddonPurchase.find(query).sort({ invoicedAt: -1 }).limit(100).lean(),
  ]);

  const packs = await AddonPack.find({
    _id: { $in: addons.map((a) => a.addonPackId) },
  }).lean();
  const packById = new Map(packs.map((p) => [String(p._id), p]));

  const items = [
    ...plans.map((p) => ({
      id: String(p._id),
      kind: "plan" as const,
      number: p.invoiceNumber as string,
      issuedAt: p.invoicedAt,
      description: `${p.planSlug} plan — ${p.cycle === "yearly" ? "12 months" : "1 month"}`,
      amount: p.amount,
      currency: p.currency,
      paymentId: p.razorpayPaymentId ?? "",
    })),
    ...addons.map((a) => {
      const pack = packById.get(String(a.addonPackId));
      return {
        id: String(a._id),
        kind: "addon" as const,
        number: a.invoiceNumber as string,
        issuedAt: a.invoicedAt,
        description: pack
          ? `${pack.name} — ${pack.quantity} ${pack.type === "audit" ? "audit" : "crawl"} credits`
          : "Add-on credit pack",
        amount: a.amount,
        currency: a.currency,
        paymentId: a.razorpayPaymentId ?? "",
      };
    }),
  ].sort((a, b) => Number(new Date(b.issuedAt as Date)) - Number(new Date(a.issuedAt as Date)));

  res.json(items);
});

/**
 * Download one receipt as a PDF.
 *
 * Regenerated on each request rather than stored: the document is a pure
 * function of a row that never changes after it is paid, so there is nothing
 * to keep in sync and no blob storage to pay for. `buildInvoice` scopes the
 * lookup by `userId`, so one account cannot fetch another's receipt by id.
 */
router.get("/invoices/:kind/:id/pdf", async (req: AuthedRequest, res: Response) => {
  const kind = req.params.kind === "plan" ? "plan" : req.params.kind === "addon" ? "addon" : null;
  if (!kind) return res.status(400).json({ error: "unknown receipt type" });

  const user = await User.findById(req.userId).select("name email");
  if (!user) return res.status(404).json({ error: "user not found" });

  const invoice = await buildInvoice(kind, String(req.params.id), String(req.userId), {
    name: (user.name as string) ?? "",
    email: user.email as string,
  });
  if (!invoice) return res.status(404).json({ error: "receipt not found" });

  const pdf = await renderInvoicePdf(invoice);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdf.length);
  res.setHeader("Content-Disposition", `attachment; filename="${invoice.number}.pdf"`);
  res.send(pdf);
});

export default router;
