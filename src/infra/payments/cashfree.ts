import crypto from "crypto";
import axios, { AxiosError } from "axios";

 
const API_VERSION = "2023-08-01";

function baseUrl(): string {
 
  return process.env.CASHFREE_ENV === "sandbox"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";
}

export function cashfreeConfigured(): boolean {
  return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

function authHeaders() {
  return {
    "x-api-version": API_VERSION,
    "x-client-id": process.env.CASHFREE_APP_ID as string,
    "x-client-secret": process.env.CASHFREE_SECRET_KEY as string,
    "Content-Type": "application/json",
  };
}

export interface CashfreeOrder {
  /** Our own id, echoed back on the order and on every webhook for it. */
  orderId: string;
  /** What the browser SDK needs to open checkout. */
  paymentSessionId: string;
}

 
export async function createCashfreeOrder(params: {
  orderId: string;
  amountMajor: number;
  currency: string;
  customer: { id: string; email: string; phone?: string; name?: string };
  notes?: Record<string, string>;
  /** Where Cashfree sends the browser back after payment. */
  returnUrl?: string;
}): Promise<CashfreeOrder> {
  if (!cashfreeConfigured()) throw new Error("Cashfree is not configured");

  try {
    const { data } = await axios.post(
      `${baseUrl()}/orders`,
      {
        order_id: params.orderId,
        order_amount: Number(params.amountMajor.toFixed(2)),
        order_currency: params.currency,
        customer_details: {
          customer_id: params.customer.id,
          customer_email: params.customer.email,
          // Cashfree requires a phone; a synthetic value is accepted for
          // card/UPI web checkout and keeps a missing profile from blocking a
          // sale.
          customer_phone: params.customer.phone || "9999999999",
          ...(params.customer.name ? { customer_name: params.customer.name } : {}),
        },
        order_note: params.notes ? JSON.stringify(params.notes).slice(0, 200) : undefined,
        order_meta: params.returnUrl ? { return_url: params.returnUrl } : undefined,
        order_tags: params.notes,
      },
      { headers: authHeaders(), timeout: 15000 },
    );

    return { orderId: data.order_id, paymentSessionId: data.payment_session_id };
  } catch (e) {
    const err = e as AxiosError<{ message?: string }>;
    const msg = err.response?.data?.message ?? err.message;
    throw new Error(`Cashfree order creation failed: ${msg}`);
  }
}

export type CashfreeOrderStatus = "PAID" | "ACTIVE" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED";

/**
 * Fetch an order's current state.
 *
 * The client-side verify path uses this: unlike Razorpay, Cashfree's browser
 * return carries no signed payload we can check ourselves, so confirmation is a
 * server-to-server read of the order status.
 */
export async function fetchCashfreeOrder(orderId: string): Promise<{
  status: CashfreeOrderStatus;
  /** The successful payment's id, once there is one. */
  paymentId: string;
}> {
  if (!cashfreeConfigured()) throw new Error("Cashfree is not configured");

  try {
    const { data } = await axios.get(`${baseUrl()}/orders/${encodeURIComponent(orderId)}`, {
      headers: authHeaders(),
      timeout: 15000,
    });

    let paymentId = "";
    if (data.order_status === "PAID") {
      // The order read gives status but not the payment id; a second call to
      // the payments-for-order endpoint has it.
      try {
        const { data: payments } = await axios.get(
          `${baseUrl()}/orders/${encodeURIComponent(orderId)}/payments`,
          { headers: authHeaders(), timeout: 15000 },
        );
        const success = Array.isArray(payments)
          ? payments.find((p: { payment_status?: string }) => p.payment_status === "SUCCESS")
          : null;
        paymentId = success ? String(success.cf_payment_id) : "";
      } catch {
        // Non-fatal: the credit path only needs to know the order is paid.
        paymentId = "";
      }
    }

    return { status: data.order_status as CashfreeOrderStatus, paymentId };
  } catch (e) {
    const err = e as AxiosError<{ message?: string }>;
    const msg = err.response?.data?.message ?? err.message;
    throw new Error(`Cashfree order lookup failed: ${msg}`);
  }
}

/**
 * Verify an inbound webhook.
 *
 * Cashfree signs `timestamp + rawBody` with HMAC-SHA256 keyed on the secret
 * key, base64-encoded, sent as `x-webhook-signature` alongside
 * `x-webhook-timestamp`. The same secret key as the API calls — there is no
 * separate webhook secret to configure.
 */
export function verifyCashfreeWebhook(
  rawBody: string,
  signature: string,
  timestamp: string,
): boolean {
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!secret || !signature || !timestamp) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
