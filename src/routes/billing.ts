import { Router, Response } from "express";
import mongoose from "mongoose";
import { AddonPack, type AddonType } from "../models/AddonPack.js";
import { Subscription, type BillingCycle } from "../models/Subscription.js";
import { AddonPurchase } from "../models/AddonPurchase.js";
import { PlanPurchase } from "../models/PlanPurchase.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";
import { razorpay, razorpayConfigured, verifyOrderPayment } from "../lib/razorpay.js";
import { activateOrbitPeriod, activatePlanPeriod } from "../lib/quota.js";
import { resolveAccess, isDenied } from "../lib/access.js";
import { Workspace } from "../models/Workspace.js";
import {
  listResolvedPlans,
  getResolvedPlan,
  listResolvedOrbitPlans,
  getResolvedOrbitPlan,
} from "../lib/planPricing.js";
import { DEFAULT_ORBIT_PLAN_SLUG } from "../orbit-plans.js";
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
 *
 * Everything sold here is sold *to a workspace*: a plan period and any addon
 * credits attach to one workspace's subscription, so every purchase route
 * takes a `workspaceId` and refuses one the caller does not own.
 */
const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

/**
 * Resolve the target workspace of a purchase, scoped to the caller's access.
 *
 * Membership is the boundary that decides whose subscription gets upgraded — an
 * unscoped lookup would let any signed-in account pay to upgrade (or, with a
 * crafted id, examine) a workspace they have nothing to do with.
 *
 * Any member may buy, including a viewer: paying for a workspace only ever adds
 * capacity to it, so there is nothing to protect against here that refusing
 * would not simply make worse. Who is *charged* is never in doubt — the order
 * is created against the caller's own account, and the receipt is theirs.
 */
async function resolveAccessibleWorkspace(
  req: AuthedRequest,
  raw: unknown,
): Promise<{ id: string } | { error: string }> {
  const workspaceId = String(raw ?? "").trim();
  if (!workspaceId) return { error: "workspaceId required — plans are bought per workspace" };
  if (!mongoose.isValidObjectId(workspaceId)) return { error: "workspace not found" };

  const access = await resolveAccess(req, "viewer", workspaceId);
  if (isDenied(access)) return { error: access.error };
  return { id: access.workspace.id };
}

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
  const workspace = await resolveAccessibleWorkspace(req, req.body?.workspaceId);
  if ("error" in workspace) return res.status(404).json({ error: workspace.error });

  const planSlug = String(req.body?.planSlug ?? "");
  const cycle: BillingCycle = req.body?.cycle === "yearly" ? "yearly" : "monthly";
  const currency = resolveCurrency(req.body?.currency);

  const plan = await getResolvedPlan(planSlug);
  if (!plan) return res.status(404).json({ error: "plan not found" });

  const planAmount = (cycle === "yearly" ? plan.priceYearly : plan.priceMonthly)[currency];

  // Addon packs bought in the same checkout. Priced server-side from the
  // catalogue — the client sends slugs and counts, never amounts, so a tampered
  // request can't buy credits at a price of its own choosing.
  const resolvedAddons = await resolveAddonSelection(req.body?.addons, currency);
  if ("error" in resolvedAddons) return res.status(400).json({ error: resolvedAddons.error });

  const listPrice = planAmount + resolvedAddons.total;
  const discounted = await applyCoupon(listPrice, req.body?.couponCode);
  if (discounted.error) return res.status(400).json({ error: discounted.error });
  const amount = discounted.amount;

  // Free has no charge to make — assign it directly rather than round-tripping
  // through Razorpay for a ₹0/$0/€0 order. A coupon can also discount a paid
  // plan to 0, which takes the same free path.
  //
  // Only when nothing else is being bought: a free plan with paid addons is a
  // real charge, and must go through checkout like any other.
  if (amount === 0 && !resolvedAddons.items.length) {
    await activatePlanPeriod(workspace.id, req.userId as string, plan.slug, cycle);
    return res.json({ free: true, plan: { name: plan.name, cycle } });
  }

  if (!razorpayConfigured())
    return res.status(503).json({ error: "payments are not configured" });

  try {
    // Razorpay rejects a zero-amount order, so a coupon generous enough to
    // wipe out a plan-plus-addons total still has to charge something. Same
    // floor the standalone addon route uses.
    const chargeable = Math.max(amount, 100);

    const order = await razorpay().orders.create({
      amount: chargeable,
      currency,
      notes: {
        userId: String(req.userId),
        workspaceId: workspace.id,
        planSlug: plan.slug,
        cycle,
        addonPacks: String(resolvedAddons.items.length),
      },
    });

    await PlanPurchase.create({
      userId: req.userId,
      workspaceId: workspace.id,
      planSlug: plan.slug,
      cycle,
      addons: resolvedAddons.items,
      planAmount,
      razorpayOrderId: order.id,
      amount: chargeable,
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
      addons: resolvedAddons.items.map((a) => ({
        name: a.name,
        type: a.type,
        packs: a.packs,
        credits: a.quantity * a.packs,
      })),
    });
  } catch (e) {
    console.error("Razorpay order failed:", (e as Error).message);
    res.status(502).json({ error: "could not start checkout with Razorpay" });
  }
});

/**
 * What a pack's credits are called on a receipt.
 *
 * A lookup rather than a ternary for the same reason as `ADDON_CREDIT_FIELD`
 * below: with three pack types, `audit ? … : …` silently labels Orbit questions
 * as crawls — and on a receipt that is a financial document stating something
 * that was never sold.
 */
function creditNoun(type: AddonType, count: number): string {
  const noun =
    type === "audit" ? "audit" : type === "crawl" ? "crawl" : "Orbit question";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Which subscription field each kind of pack credits.
 *
 * A lookup rather than a ternary because there are now three kinds: a
 * two-branch `audit ? … : …` would silently credit Orbit questions as crawls,
 * and a purchase credited to the wrong quota still issues a correct-looking
 * receipt, so the mistake would surface as a support ticket rather than an
 * error. An unmapped type credits nothing.
 */
const ADDON_CREDIT_FIELD: Record<AddonType, string> = {
  audit: "addonAuditCredits",
  crawl: "addonCrawlCredits",
  orbit: "addonOrbitCredits",
};

/** One addon line as it is stored on a purchase and credited on payment. */
type ResolvedAddon = {
  addonPackId: string;
  name: string;
  type: string;
  quantity: number;
  packs: number;
  unitAmount: number;
};

/** How many of one pack a single checkout may include. */
const MAX_PACKS_PER_ADDON = 50;

/**
 * Turn a client's `[{slug, packs}]` selection into priced line items.
 *
 * Every figure comes from the catalogue, not the request: the client chooses
 * *what* and *how many*, never *for how much*. Bounded per line because an
 * unbounded quantity is an integer-overflow-shaped hole in the order total, and
 * nobody legitimately buys fifty-one packs in one go.
 */
async function resolveAddonSelection(
  input: unknown,
  currency: ReturnType<typeof resolveCurrency>,
): Promise<{ items: ResolvedAddon[]; total: number } | { error: string }> {
  if (!Array.isArray(input) || !input.length) return { items: [], total: 0 };

  const items: ResolvedAddon[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const entry of input) {
    const slug = String((entry as { slug?: unknown })?.slug ?? "");
    const packs = Number((entry as { packs?: unknown })?.packs ?? 0);

    if (!slug) return { error: "each addon needs a slug" };
    if (!Number.isInteger(packs) || packs < 1)
      return { error: `addon "${slug}": packs must be a whole number of at least 1` };
    if (packs > MAX_PACKS_PER_ADDON)
      return { error: `addon "${slug}": at most ${MAX_PACKS_PER_ADDON} packs per purchase` };
    // A repeated slug would be credited twice while showing as one line on the
    // receipt — reject it rather than silently merging, since the client should
    // not be sending it and quietly "fixing" it hides a bug there.
    if (seen.has(slug)) return { error: `addon "${slug}" listed more than once` };
    seen.add(slug);

    const pack = await AddonPack.findOne({ slug, active: true });
    if (!pack) return { error: `addon "${slug}" not found` };

    const unitAmount = (pack.price as unknown as Record<string, number>)[currency] ?? 0;

    items.push({
      addonPackId: pack.id,
      name: pack.name as string,
      type: pack.type as string,
      quantity: pack.quantity as number,
      packs,
      unitAmount,
    });
    total += unitAmount * packs;
  }

  return { items, total };
}

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

  const workspace = await resolveAccessibleWorkspace(req, req.body?.workspaceId);
  if ("error" in workspace) return res.status(404).json({ error: workspace.error });

  const pack = await AddonPack.findOne({ slug: req.params.slug, active: true });
  if (!pack) return res.status(404).json({ error: "addon not found" });

  const currency = resolveCurrency(req.body?.currency);

  const packs = Number(req.body?.packs ?? 1);
  if (!Number.isInteger(packs) || packs < 1)
    return res.status(400).json({ error: "packs must be a whole number of at least 1" });
  if (packs > MAX_PACKS_PER_ADDON)
    return res.status(400).json({ error: `at most ${MAX_PACKS_PER_ADDON} packs per purchase` });

  // Priced from the catalogue and multiplied here — the client sends a count,
  // never an amount.
  const price = ((pack.price as unknown as Record<string, number>)[currency] ?? 0) * packs;
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
      notes: {
        userId: String(req.userId),
        workspaceId: workspace.id,
        addonPackId: String(pack.id),
        packs: String(packs),
      },
    });

    await AddonPurchase.create({
      userId: req.userId,
      workspaceId: workspace.id,
      addonPackId: pack.id,
      packs,
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
      addon: {
        name: pack.name,
        type: pack.type,
        quantity: pack.quantity,
        packs,
        credits: (pack.quantity as number) * packs,
      },
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
 * Which workspace a purchase applies to.
 *
 * Normally just the id stored on the row. The fallback covers orders placed
 * before billing moved to workspaces, and orders whose webhook arrives after
 * the workspace was deleted: an in-flight legacy order must still land
 * somewhere, and the account's oldest workspace is where the migration put
 * that account's plan, so the two agree. Null when the account has no
 * workspaces at all, which the callers treat as nothing to credit.
 */
async function purchaseWorkspaceId(stored: unknown, userId: unknown): Promise<string | null> {
  if (stored) return String(stored);
  const oldest = await Workspace.findOne({ userId: String(userId) })
    .sort({ createdAt: 1 })
    .select("_id");
  return oldest ? String(oldest._id) : null;
}

/**
 * Credit an addon purchase's pack quantity onto the workspace's subscription.
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

  const workspaceId = await purchaseWorkspaceId(purchase.workspaceId, purchase.userId);
  if (!workspaceId) return;

  const field = ADDON_CREDIT_FIELD[pack.type as AddonType];
  if (!field) return;
  // `packs` defaults to 1, so rows written before multi-pack checkout credit
  // exactly as they always did.
  const packs = (purchase.packs as number) ?? 1;
  await Subscription.updateOne(
    { workspaceId },
    { $inc: { [field]: (pack.quantity as number) * packs } }
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

  const workspaceId = await purchaseWorkspaceId(purchase.workspaceId, purchase.userId);
  // Nothing to activate against. Only reachable if the buyer deleted the
  // workspace between paying and the webhook landing; the purchase stays marked
  // paid so it still appears in their receipts and can be refunded by hand.
  if (!workspaceId) return;

  // An Orbit purchase moves the AI tier and resets its question count, and must
  // leave the analytics period and its audit/crawl usage completely alone —
  // buying Orbit Pro mid-cycle should not restart someone's analytics month or
  // refund the audits they have already spent.
  if (purchase.ladder === "orbit") {
    await activateOrbitPeriod(
      workspaceId,
      String(purchase.userId),
      purchase.planSlug as string,
      purchase.cycle as BillingCycle,
    );
  } else {
    await activatePlanPeriod(
      workspaceId,
      String(purchase.userId),
      purchase.planSlug as string,
      purchase.cycle as BillingCycle
    );
  }

  // Packs bought in the same checkout. Credited after the period is activated,
  // because activation resets the cycle's usage counters — crediting first
  // would be undone by it. Addon credits themselves survive the reset; they
  // live in separate fields precisely so a new period can't clear them.
  const addons = (purchase.addons ?? []) as unknown as {
    type: string;
    quantity: number;
    packs: number;
  }[];

  if (addons.length) {
    const increments: Record<string, number> = {};
    for (const addon of addons) {
      const field = ADDON_CREDIT_FIELD[addon.type as AddonType];
      // An unrecognised type is skipped rather than defaulted onto some other
      // credit field: crediting the wrong quota is worse than crediting none,
      // because it is silent and the receipt still says it was paid for.
      if (!field) continue;
      increments[field] = (increments[field] ?? 0) + addon.quantity * addon.packs;
    }
    await Subscription.updateOne({ workspaceId }, { $inc: increments });
  }

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

  const rawWorkspaceId = String(req.query.workspaceId ?? "").trim();
  let workspaceFilter: Record<string, unknown> = {};

  if (rawWorkspaceId) {
    if (!mongoose.isValidObjectId(rawWorkspaceId))
      return res.status(404).json({ error: "workspace not found" });

    const access = await resolveAccess(req, "viewer", rawWorkspaceId);
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });

    workspaceFilter = { workspaceId: access.workspace.id };
  }

  const query = {
    userId: req.userId,
    status: "paid" as const,
    invoiceNumber: { $nin: ["", null] },
    ...workspaceFilter,
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
    ...plans.map((p) => {
      const packCount = (p.addons ?? []).length;
      const planLine = `${p.planSlug} plan — ${p.cycle === "yearly" ? "12 months" : "1 month"}`;
      return {
        id: String(p._id),
        kind: "plan" as const,
        number: p.invoiceNumber as string,
        issuedAt: p.invoicedAt,
        description: packCount
          ? `${planLine}, plus ${packCount} add-on pack${packCount === 1 ? "" : "s"}`
          : planLine,
        amount: p.amount,
        currency: p.currency,
        paymentId: p.razorpayPaymentId ?? "",
      };
    }),
    ...addons.map((a) => {
      const pack = packById.get(String(a.addonPackId));
      const packs = (a.packs as number) ?? 1;
      return {
        id: String(a._id),
        kind: "addon" as const,
        number: a.invoiceNumber as string,
        issuedAt: a.invoicedAt,
        description: pack
          ? `${pack.name}${packs > 1 ? ` × ${packs}` : ""} — ${creditNoun(pack.type as AddonType, pack.quantity * packs)}`
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
