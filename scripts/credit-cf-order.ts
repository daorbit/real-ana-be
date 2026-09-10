import "dotenv/config";
import mongoose from "mongoose";
import axios from "axios";
import { creditPlanPurchase, creditAddonPurchase } from "../src/http/routes/billing.js";
import { PlanPurchase } from "../src/modules/billing/models/PlanPurchase.js";
import { AddonPurchase } from "../src/modules/billing/models/AddonPurchase.js";

/**
 * One-off: credit a Cashfree order that is PAID at the gateway but still
 * `created` locally, because its webhook was never configured and the browser
 * redirect landed on a 404 so the client-side verify never ran.
 *
 * Usage: npx tsx scripts/credit-cf-order.ts <cf_order_id>
 */
const orderId = process.argv[2];
if (!orderId) {
  console.error("pass a cf order id");
  process.exit(1);
}

const APP = process.env.CASHFREE_APP_ID!;
const SEC = process.env.CASHFREE_SECRET_KEY!;
const base =
  process.env.CASHFREE_ENV === "sandbox"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";

await mongoose.connect(process.env.MONGODB_URI!);

const { data: order } = await axios.get(`${base}/orders/${orderId}`, {
  headers: { "x-api-version": "2025-01-01", "x-client-id": APP, "x-client-secret": SEC },
});
console.log("order_status:", order.order_status);
if (order.order_status !== "PAID") {
  console.log("not paid — nothing to credit");
  process.exit(0);
}

const { data: pays } = await axios.get(`${base}/orders/${orderId}/payments`, {
  headers: { "x-api-version": "2025-01-01", "x-client-id": APP, "x-client-secret": SEC },
});
const success = (Array.isArray(pays) ? pays : []).find(
  (p: { payment_status?: string }) => p.payment_status === "SUCCESS",
);
const paymentId = success ? String(success.cf_payment_id) : "";
console.log("paymentId:", paymentId);

const plan = await PlanPurchase.findOne({ cashfreeOrderId: orderId });
if (plan) {
  await creditPlanPurchase(plan.id, paymentId);
  const after = await PlanPurchase.findById(plan.id);
  console.log("plan credited — status:", after?.status, "invoice:", after?.invoiceNumber);
  process.exit(0);
}

const addon = await AddonPurchase.findOne({ cashfreeOrderId: orderId });
if (addon) {
  await creditAddonPurchase(addon.id, paymentId);
  const after = await AddonPurchase.findById(addon.id);
  console.log("addon credited — status:", after?.status, "invoice:", after?.invoiceNumber);
  process.exit(0);
}

console.log("no purchase row for that order id");
process.exit(1);
