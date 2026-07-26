import Razorpay from "razorpay";
import crypto from "crypto";

let client: Razorpay | null = null;

/** Lazily constructed so a missing key only breaks billing routes, not boot. */
export function razorpay(): Razorpay {
  if (client) return client;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) throw new Error("Razorpay is not configured");
  client = new Razorpay({ key_id, key_secret });
  return client;
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/** HMAC-SHA256 over `body`, hex-encoded — the shape Razorpay signs with for both checkout callbacks and webhooks. */
function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Verify a checkout success callback for a one-time order (addon purchase).
 * Razorpay's documented scheme: HMAC of `order_id|payment_id` using the key secret.
 */
export function verifyOrderPayment(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = sign(`${params.orderId}|${params.paymentId}`, secret);
  return timingSafeEqual(expected, params.signature);
}

/** Verify an incoming webhook body against `RAZORPAY_WEBHOOK_SECRET`. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = sign(rawBody, secret);
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
