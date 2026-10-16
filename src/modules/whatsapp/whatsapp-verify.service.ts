import { createHash, randomInt } from "node:crypto";
import { WhatsAppConnection } from "./models/WhatsAppConnection.js";
import { WhatsAppVerification } from "./models/WhatsAppVerification.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { normalizePhone, sendWhatsApp } from "../../infra/messaging/whatsapp.js";
import { safeEqual } from "../../shared/utils/crypto-box.js";
import { MAX_NUMBERS, WhatsAppError, loadWhatsApp, requireEntitled, whatsappStatus, type WhatsAppStatus } from "./whatsapp.service.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function hashCode(workspaceId: string, phone: string, code: string): string {
  return createHash("sha256").update(`${workspaceId}:${phone}:${code}`).digest("hex");
}

export async function startVerification(workspaceId: string, rawPhone: string, label: string): Promise<{ phone: string; expiresAt: Date }> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new WhatsAppError("Enter the number with its country code, like +91 98765 43210");
  await requireEntitled(workspaceId);

  const [doc, workspace] = await Promise.all([
    loadWhatsApp(workspaceId),
    Workspace.findById(workspaceId).select("name").lean<{ name?: string }>(),
  ]);
  const numbers = doc?.numbers ?? [];
  if (numbers.some((n) => n.phone === phone)) throw new WhatsAppError("That number is already added");
  if (numbers.length >= MAX_NUMBERS) throw new WhatsAppError(`You can add up to ${MAX_NUMBERS} numbers`);

  const code = String(randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await sendWhatsApp(
    phone,
    `Your Quantalog code is *${code}*.\nEnter it to receive reports and form alerts from ${workspace?.name ?? "your workspace"} on this number. It expires in 10 minutes.`
  );
  await WhatsAppVerification.findOneAndUpdate(
    { workspaceId, phone },
    { $set: { codeHash: hashCode(workspaceId, phone, code), label: label.trim().slice(0, 60), attempts: 0, expiresAt } },
    { upsert: true }
  );
  return { phone, expiresAt };
}

export async function confirmVerification(workspaceId: string, rawPhone: string, code: string): Promise<WhatsAppStatus> {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new WhatsAppError("That number is not valid");
  const pending = await WhatsAppVerification.findOne({ workspaceId, phone, expiresAt: { $gt: new Date() } });
  if (!pending) throw new WhatsAppError("That code has expired. Send a new one.");
  if (pending.get("attempts") >= MAX_ATTEMPTS) throw new WhatsAppError("Too many wrong codes. Send a new one.");

  if (!safeEqual(hashCode(workspaceId, phone, code.trim()), String(pending.get("codeHash")))) {
    await WhatsAppVerification.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } });
    throw new WhatsAppError("That code is not right");
  }

  await Promise.all([
    WhatsAppConnection.updateOne(
      { workspaceId, "numbers.phone": { $ne: phone } },
      { $push: { numbers: { phone, label: pending.get("label") ?? "", formAlerts: true, verifiedAt: new Date() } } },
      { upsert: true }
    ).catch((e: { code?: number }) => {
      if (e?.code !== 11000) throw e;
    }),
    WhatsAppVerification.deleteOne({ _id: pending._id }),
  ]);
  return whatsappStatus(workspaceId);
}
