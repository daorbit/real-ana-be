import { randomBytes } from "node:crypto";
import { mailConfigured, sendOne } from "../../infra/mail/mailer.js";
import { overRateLimit } from "../security/rate-limit.service.js";
import { AppError, badRequest, tooManyRequests } from "../../shared/errors/index.js";
import { StatusSubscriber } from "./models/StatusSubscriber.js";
import { confirmEmail } from "./emails.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL = 254;

const newToken = () => randomBytes(24).toString("base64url");

export async function subscribe(rawEmail: unknown, ip: string): Promise<void> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL || !EMAIL.test(email)) throw badRequest("Enter a valid email address");
  if (!mailConfigured()) throw new AppError(503, "Email updates are not available right now");

  const [ipBusy, emailBusy] = await Promise.all([
    overRateLimit(`status-sub-ip:${ip}`, 5, HOUR_MS),
    overRateLimit(`status-sub-email:${email}`, 3, DAY_MS),
  ]);
  if (ipBusy || emailBusy) throw tooManyRequests("Too many attempts. Try again later.");

  const existing = await StatusSubscriber.findOne({ email }).select("token confirmedAt").lean<{ token: string; confirmedAt: Date | null }>();
  if (existing?.confirmedAt) return;

  const token = existing?.token ?? newToken();
  if (!existing) await StatusSubscriber.create({ email, token });

  const message = confirmEmail(token);
  await sendOne({ email }, message.subject, message.text, message.html);
}

export async function confirmSubscription(token: string): Promise<boolean> {
  if (!token) return false;
  const result = await StatusSubscriber.updateOne({ token }, [{ $set: { confirmedAt: { $ifNull: ["$confirmedAt", "$$NOW"] } } }]);
  return result.matchedCount === 1;
}

export async function unsubscribe(token: string): Promise<boolean> {
  if (!token) return false;
  const result = await StatusSubscriber.deleteOne({ token });
  return result.deletedCount === 1;
}

export async function subscriberCounts() {
  const [confirmed, pending] = await Promise.all([
    StatusSubscriber.countDocuments({ confirmedAt: { $ne: null } }),
    StatusSubscriber.countDocuments({ confirmedAt: null }),
  ]);
  return { confirmed, pending };
}
