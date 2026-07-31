import axios from "axios";

/**
 * WhatsApp delivery, via WireWeb.
 *
 * WireWeb is an unofficial gateway: it pairs a real WhatsApp account by QR code
 * rather than going through Meta's Cloud API. Two consequences shape everything
 * here, and neither is a detail:
 *
 *  - the paired session drops. A phone going offline, a re-pair, or Meta taking
 *    exception to the account all end it, so `sessionStatus` is checked before
 *    a run rather than discovering it one failed send at a time.
 *  - the account can be banned. That makes WhatsApp a channel for alerting the
 *    account owner, not a channel to put customer-facing messaging on. The
 *    product treats it as an addition to email, never a replacement.
 *
 * The base URL is configuration rather than a constant: WireWeb's own docs
 * publish `api.example.com` as a placeholder, so the real host is something an
 * operator has to supply and could plausibly change.
 */

const DEFAULT_BASE_URL = "https://app.wireweb.co.in/api";

export type WhatsAppSession = {
  id: string;
  status: "connected" | "pairing" | "disconnected" | string;
  phoneNumber?: string;
  name?: string;
};

export function whatsappConfigured(): boolean {
  return Boolean(process.env.WIREWEB_API_KEY && process.env.WIREWEB_SESSION_ID);
}

function baseUrl(): string {
  return (process.env.WIREWEB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.WIREWEB_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Normalises a number to the digits-only form the gateway expects.
 *
 * WhatsApp addresses by country code without a `+`, so `+91 70820 72347`,
 * `+917082072347` and `917082072347` are all the same destination — and a user
 * typing any of them should not silently get no message.
 */
export function normalizePhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  // Shorter than 8 is not a reachable international number; longer than 15 is
  // past the E.164 maximum, so both are typos rather than destinations.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** Whether a string looks like a sendable number, for form validation. */
export function isValidPhone(raw: string): boolean {
  return normalizePhone(raw) !== null;
}

export class WhatsAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppError";
  }
}

/**
 * The paired session's current state.
 *
 * Called before a batch so a disconnected session is reported once, as itself,
 * rather than as a series of identical send failures.
 */
export async function sessionStatus(): Promise<WhatsAppSession> {
  if (!whatsappConfigured()) throw new WhatsAppError("WhatsApp is not configured");

  const sessionId = process.env.WIREWEB_SESSION_ID as string;
  try {
    const { data } = await axios.get(`${baseUrl()}/v1/whatsapp/sessions/${sessionId}`, {
      headers: authHeaders(),
      timeout: 15_000,
    });
    return {
      id: data?.id ?? sessionId,
      status: data?.status ?? "unknown",
      phoneNumber: data?.phoneNumber,
      name: data?.name,
    };
  } catch (e) {
    throw new WhatsAppError(describeError(e));
  }
}

/**
 * Send one text message.
 *
 * Throws on failure rather than returning a flag: every caller here is inside a
 * per-recipient try/catch that records which addresses failed, and a silent
 * false would be collected as a success.
 */
export async function sendWhatsApp(to: string, text: string): Promise<string> {
  if (!whatsappConfigured()) throw new WhatsAppError("WhatsApp is not configured");

  const phone = normalizePhone(to);
  if (!phone) throw new WhatsAppError(`"${to}" is not a valid phone number`);

  try {
    const { data } = await axios.post(
      `${baseUrl()}/v1/messages`,
      { sessionId: process.env.WIREWEB_SESSION_ID, to: phone, text },
      { headers: authHeaders(), timeout: 20_000 }
    );
    return String(data?.messageId ?? "");
  } catch (e) {
    throw new WhatsAppError(describeError(e));
  }
}

/**
 * The gateway's own error text where it has one.
 *
 * `{"message":"session not found"}` tells an operator what to fix; "Request
 * failed with status code 404" does not.
 */
function describeError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const message = (e.response?.data as { message?: string } | undefined)?.message;
    if (message) return message;
    if (e.code === "ECONNABORTED") return "WhatsApp gateway timed out";
    return e.response ? `WhatsApp gateway returned ${e.response.status}` : e.message;
  }
  return (e as Error).message;
}
