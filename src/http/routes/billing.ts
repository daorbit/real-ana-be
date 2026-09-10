import { Router, Response, type RequestHandler } from "express";
import mongoose from "mongoose";
import { AddonPack, type AddonType } from "../../modules/billing/models/AddonPack.js";
import { Subscription, type BillingCycle } from "../../modules/billing/models/Subscription.js";
import { AddonPurchase } from "../../modules/billing/models/AddonPurchase.js";
import { PlanPurchase } from "../../modules/billing/models/PlanPurchase.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { razorpay, razorpayConfigured, verifyOrderPayment } from "../../infra/payments/razorpay.js";
import {
  cashfreeConfigured,
  createCashfreeOrder,
  fetchCashfreeOrder,
  toCashfreePhone,
} from "../../infra/payments/cashfree.js";
import crypto from "crypto";
import {
  activateOrbitPeriod,
  activatePlanPeriod,
  paidPlan,
  renewalWouldExceedCap,
  MAX_PREPAID_CYCLES,
} from "../../modules/billing/quota.service.js";
import { resolveAccess, isDenied } from "../../modules/workspace/access.service.js";
import { Workspace } from "../../modules/workspace/models/Workspace.js";
import {
  listResolvedPlans,
  getResolvedPlan,
  listResolvedOrbitPlans,
  getResolvedOrbitPlan,
} from "../../modules/billing/plan-pricing.js";
import { DEFAULT_ORBIT_PLAN_SLUG } from "../../modules/orbit/orbit-plans.catalog.js";
import { getPlanCatalogEntry } from "../../modules/billing/plans.catalog.js";
import { applyCoupon } from "../../modules/billing/coupons.js";
import { resolveCurrency } from "../../modules/billing/currency.js";
import { User } from "../../modules/identity/models/User.js";
import {
  buildInvoice,
  nextInvoiceNumber,
  renderInvoicePdf,
  formatAmount,
  type InvoiceKind,
} from "../../modules/billing/invoice.js";
import { sendInvoiceEmail, mailConfigured } from "../../infra/mail/mailer.js";

 
const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

 
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

/* -------------------------------- gateways --------------------------------- */

export type Gateway = "razorpay" | "cashfree";

/** The client picks a gateway per checkout; anything unrecognised falls back to Razorpay. */
function resolveGateway(raw: unknown): Gateway {
  return raw === "cashfree" ? "cashfree" : "razorpay";
}

function gatewayConfigured(gateway: Gateway): boolean {
  return gateway === "cashfree" ? cashfreeConfigured() : razorpayConfigured();
}

 
async function resolveCashfreePhone(
  bodyPhone: unknown,
  userId: unknown,
): Promise<{ phone: string } | { error: string }> {
  const fromForm = toCashfreePhone(typeof bodyPhone === "string" ? bodyPhone : "");
  if (fromForm) return { phone: fromForm };

  const user = await User.findById(String(userId)).select("mobile");
  const fromProfile = toCashfreePhone(user?.mobile as string | undefined);
  if (fromProfile) return { phone: fromProfile };

  return {
    error:
      "Cashfree needs a 10-digit mobile number. Add one in the checkout form or save it to your profile.",
  };
}

 
async function openOrder(params: {
  gateway: Gateway;
  amountMinor: number;
  currency: string;
  notes: Record<string, string>;
  buyer: { id: string; email: string; name?: string; phone?: string };
}): Promise<
  | {
      ok: true;
      orderIdField: "razorpayOrderId" | "cashfreeOrderId";
      orderId: string;
      /** What the client needs to launch checkout. */
      client:
        | { gateway: "razorpay"; orderId: string; amount: number; currency: string; razorpayKeyId?: string }
        | { gateway: "cashfree"; orderId: string; paymentSessionId: string; cashfreeMode: string };
    }
  | { ok: false; error: string }
> {
  const { gateway, amountMinor, currency, notes, buyer } = params;

  try {
    if (gateway === "cashfree") {
      // Cashfree order ids must be unique and are ours to choose.
      const orderId = `cf_${crypto.randomUUID()}`;

      const order = await createCashfreeOrder({
        orderId,
        amountMajor: amountMinor / 100,
        currency,
        customer: { id: buyer.id, email: buyer.email, name: buyer.name, phone: buyer.phone },
        notes,
      });
      return {
        ok: true,
        orderIdField: "cashfreeOrderId",
        orderId: order.orderId,
        client: {
          gateway: "cashfree",
          orderId: order.orderId,
          paymentSessionId: order.paymentSessionId,
          cashfreeMode: process.env.CASHFREE_ENV === "sandbox" ? "sandbox" : "production",
        },
      };
    }

    const order = await razorpay().orders.create({ amount: amountMinor, currency, notes });
    return {
      ok: true,
      orderIdField: "razorpayOrderId",
      orderId: order.id,
      client: {
        gateway: "razorpay",
        orderId: order.id,
        amount: Number(order.amount),
        currency: String(order.currency),
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      },
    };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`${gateway} order failed:`, msg);

    return { ok: false, error: msg || `could not start checkout with ${gateway}` };
  }
}

/* --------------------------------- catalogue -------------------------------- */

router.get("/plans", async (_req: AuthedRequest, res: Response) => {
  res.json(await listResolvedPlans());
});

router.get("/addons", async (_req: AuthedRequest, res: Response) => {
  const addons = await AddonPack.find({ active: true }).sort({ sortOrder: 1 });
  res.json(addons);
});

 
router.post("/coupons/check", async (req: AuthedRequest, res: Response) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 0)
    return res.status(400).json({ error: "amount must be a non-negative number" });

  const result = await applyCoupon(amount, req.body?.code);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

 
router.post("/subscribe", async (req: AuthedRequest, res: Response) => {
  const workspace = await resolveAccessibleWorkspace(req, req.body?.workspaceId);
  if ("error" in workspace) return res.status(404).json({ error: workspace.error });

  const planSlug = String(req.body?.planSlug ?? "");
  const cycle: BillingCycle = req.body?.cycle === "yearly" ? "yearly" : "monthly";
  const currency = resolveCurrency(req.body?.currency);

  const plan = await getResolvedPlan(planSlug);
  if (!plan) return res.status(404).json({ error: "plan not found" });

  const active = await paidPlan(workspace.id);
  if (active && getPlanCatalogEntry(plan.slug)!.sortOrder < active.sortOrder) {
    return res.status(409).json({
      error: `this workspace is on ${active.name} until its period ends — a lower plan cannot be bought before then`,
      code: "downgrade_blocked",
    });
  }

 
  if (await renewalWouldExceedCap(workspace.id, plan.slug, cycle)) {
    return res.status(409).json({
      error: `this plan is already paid up ${MAX_PREPAID_CYCLES} cycles ahead — renew again closer to the renewal date`,
      code: "renewal_cap_reached",
    });
  }

  const planAmount = (cycle === "yearly" ? plan.priceYearly : plan.priceMonthly)[currency];
 
  const resolvedAddons = await resolveAddonSelection(req.body?.addons, currency);
  if ("error" in resolvedAddons) return res.status(400).json({ error: resolvedAddons.error });

  const listPrice = planAmount + resolvedAddons.total;
  const discounted = await applyCoupon(listPrice, req.body?.couponCode);
  if (discounted.error) return res.status(400).json({ error: discounted.error });
  const amount = discounted.amount;

 
  if (amount === 0 && !resolvedAddons.items.length) {
    await activatePlanPeriod(workspace.id, req.userId as string, plan.slug, cycle);
    return res.json({ free: true, plan: { name: plan.name, cycle } });
  }

  const gateway = resolveGateway(req.body?.gateway);
  if (!gatewayConfigured(gateway))
    return res.status(503).json({ error: `${gateway} payments are not configured` });
 
  const chargeable = Math.max(amount, 100);

  const buyer = await User.findById(req.userId).select("name email");
  if (!buyer?.email) return res.status(400).json({ error: "your account has no email on file" });

  let phone: string | undefined;
  if (gateway === "cashfree") {
    const resolved = await resolveCashfreePhone(req.body?.phone, req.userId);
    if ("error" in resolved) return res.status(400).json({ error: resolved.error, code: "phone_required" });
    phone = resolved.phone;
  }

  const opened = await openOrder({
    gateway,
    amountMinor: chargeable,
    currency,
    notes: {
      userId: String(req.userId),
      workspaceId: workspace.id,
      planSlug: plan.slug,
      cycle,
      addonPacks: String(resolvedAddons.items.length),
    },
    buyer: { id: String(req.userId), email: String(buyer.email), name: String(buyer.name ?? ""), phone },
  });
  if (!opened.ok) return res.status(502).json({ error: opened.error });

  await PlanPurchase.create({
    userId: req.userId,
    workspaceId: workspace.id,
    planSlug: plan.slug,
    cycle,
    addons: resolvedAddons.items,
    planAmount,
    gateway,
    [opened.orderIdField]: opened.orderId,
    amount: chargeable,
    currency,
    couponCode: discounted.coupon?.code ?? "",
    status: "created",
  });

  res.json({
    ...opened.client,
    plan: { name: plan.name, cycle },
    addons: resolvedAddons.items.map((a) => ({
      name: a.name,
      type: a.type,
      packs: a.packs,
      credits: a.quantity * a.packs,
    })),
  });
});

 
const CREDIT_NOUN: Record<AddonType, string> = {
  audit: "audit",
  crawl: "crawl",
  orbit: "Orbit question",
  "post-slots": "scheduled post slot",
  "form-submissions": "form response",
};

function creditNoun(type: AddonType, count: number): string {
  const noun = CREDIT_NOUN[type];
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

 
const ADDON_CREDIT_FIELD: Record<AddonType, string> = {
  audit: "addonAuditCredits",
  crawl: "addonCrawlCredits",
  orbit: "addonOrbitCredits",
 
  "post-slots": "addonPostSlots",
  "form-submissions": "addonFormSubmissionCredits",
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

/** Find a purchase by whichever gateway order id it carries, in either collection. */
async function findPurchaseByOrder(field: "razorpayOrderId" | "cashfreeOrderId", orderId: string) {
  const plan = await PlanPurchase.findOne({ [field]: orderId });
  if (plan) return { kind: "plan" as const, id: String(plan._id) };
  const addon = await AddonPurchase.findOne({ [field]: orderId });
  if (addon) return { kind: "addon" as const, id: String(addon._id) };
  return null;
}

function creditFor(kind: "plan" | "addon") {
  return kind === "plan" ? creditPlanPurchase : creditAddonPurchase;
}

 
const confirmPurchase: RequestHandler = async (req, res) => {
  const b = (req as AuthedRequest).body ?? {};
  const gateway = resolveGateway(b.gateway);

  if (gateway === "cashfree") {
    const orderId = String(b.cashfree_order_id ?? b.cf_order_id ?? b.order_id ?? "");
    if (!orderId) return res.status(400).json({ error: "missing order id" });

    const purchase = await findPurchaseByOrder("cashfreeOrderId", orderId);
    if (!purchase) return res.status(404).json({ error: "purchase not found" });

    let order;
    try {
      order = await fetchCashfreeOrder(orderId);
    } catch (e) {
      return res.status(502).json({ error: (e as Error).message });
    }
    if (order.status !== "PAID")
      return res.status(409).json({ error: "payment not completed", status: order.status });

    await creditFor(purchase.kind)(purchase.id, order.paymentId);
    return res.json({ ok: true, kind: purchase.kind });
  }

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = b;
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature)
    return res.status(400).json({ error: "missing verification fields" });

  const ok = verifyOrderPayment({
    orderId: String(razorpay_order_id),
    paymentId: String(razorpay_payment_id),
    signature: String(razorpay_signature),
  });
  if (!ok) return res.status(400).json({ error: "signature mismatch" });

  const purchase = await findPurchaseByOrder("razorpayOrderId", String(razorpay_order_id));
  if (!purchase) return res.status(404).json({ error: "purchase not found" });

  await creditFor(purchase.kind)(purchase.id, String(razorpay_payment_id));
  res.json({ ok: true, kind: purchase.kind });
};

router.post("/confirm", confirmPurchase);

 
router.post("/subscribe/verify", confirmPurchase);
router.post("/addons/verify", confirmPurchase);
router.post("/cashfree/confirm", (req, res, next) => {
  req.body = { ...req.body, gateway: "cashfree" };
  confirmPurchase(req, res, next);
});

 
router.post("/addons/:slug/purchase", async (req: AuthedRequest, res: Response) => {
  const gateway = resolveGateway(req.body?.gateway);
  if (!gatewayConfigured(gateway))
    return res.status(503).json({ error: `${gateway} payments are not configured` });

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

 
  const price = ((pack.price as unknown as Record<string, number>)[currency] ?? 0) * packs;
  const discounted = await applyCoupon(price, req.body?.couponCode);
  if (discounted.error) return res.status(400).json({ error: discounted.error });

 
  const amount = Math.max(discounted.amount, 100);

  const buyer = await User.findById(req.userId).select("name email");
  if (!buyer?.email) return res.status(400).json({ error: "your account has no email on file" });

  let phone: string | undefined;
  if (gateway === "cashfree") {
    const resolved = await resolveCashfreePhone(req.body?.phone, req.userId);
    if ("error" in resolved) return res.status(400).json({ error: resolved.error, code: "phone_required" });
    phone = resolved.phone;
  }

  const opened = await openOrder({
    gateway,
    amountMinor: amount,
    currency,
    notes: {
      userId: String(req.userId),
      workspaceId: workspace.id,
      addonPackId: String(pack.id),
      packs: String(packs),
    },
    buyer: { id: String(req.userId), email: String(buyer.email), name: String(buyer.name ?? ""), phone },
  });
  if (!opened.ok) return res.status(502).json({ error: opened.error });

  await AddonPurchase.create({
    userId: req.userId,
    workspaceId: workspace.id,
    addonPackId: pack.id,
    packs,
    gateway,
    [opened.orderIdField]: opened.orderId,
    amount,
    currency,
    couponCode: discounted.coupon?.code ?? "",
    status: "created",
  });

  res.json({
    ...opened.client,
    addon: {
      name: pack.name,
      type: pack.type,
      quantity: pack.quantity,
      packs,
      credits: (pack.quantity as number) * packs,
    },
  });
});

async function purchaseWorkspaceId(stored: unknown, userId: unknown): Promise<string | null> {
  if (stored) return String(stored);
  const oldest = await Workspace.findOne({ userId: String(userId) })
    .sort({ createdAt: 1 })
    .select("_id");
  return oldest ? String(oldest._id) : null;
}

 
export async function creditAddonPurchase(purchaseId: string, paymentId: string) {
 
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
 
  const packs = (purchase.packs as number) ?? 1;
  await Subscription.updateOne(
    { workspaceId },
    { $inc: { [field]: (pack.quantity as number) * packs } }
  );

  await issueReceipt("addon", purchase.id, String(purchase.userId));
}

 
export async function creditPlanPurchase(purchaseId: string, paymentId: string) {
  const purchase = await PlanPurchase.findOneAndUpdate(
    { _id: purchaseId, status: { $ne: "paid" } },
    { $set: { status: "paid", razorpayPaymentId: paymentId } },
  );
  if (!purchase) return;

  const workspaceId = await purchaseWorkspaceId(purchase.workspaceId, purchase.userId);
 
  if (!workspaceId) return;

 
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
 
  const addons = (purchase.addons ?? []) as unknown as {
    type: string;
    quantity: number;
    packs: number;
  }[];

  if (addons.length) {
    const increments: Record<string, number> = {};
    for (const addon of addons) {
      const field = ADDON_CREDIT_FIELD[addon.type as AddonType];
 
      if (!field) continue;
      increments[field] = (increments[field] ?? 0) + addon.quantity * addon.packs;
    }
    await Subscription.updateOne({ workspaceId }, { $inc: increments });
  }

  await issueReceipt("plan", purchase.id, String(purchase.userId));
}

 
async function issueReceipt(kind: InvoiceKind, purchaseId: string, userId: string) {
  try {
    const issuedAt = new Date();
    const number = await nextInvoiceNumber(issuedAt);
 
    const filter = { _id: purchaseId, $or: [{ invoiceNumber: "" }, { invoiceNumber: null }] };
    const update = { $set: { invoiceNumber: number, invoicedAt: issuedAt } };

 
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
