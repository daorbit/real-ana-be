import { WhatsAppConnection } from "./models/WhatsAppConnection.js";
import { currentPlan } from "../billing/quota.service.js";
import { WhatsAppError, sendWhatsApp, whatsappConfigured } from "../../infra/messaging/whatsapp.js";

export const MAX_NUMBERS = 10;

export { WhatsAppError };

export type WhatsAppNumber = { phone: string; label: string; formAlerts: boolean; verifiedAt: Date };

export type WhatsAppStatus = {
  available: boolean;
  entitled: boolean;
  planName: string | null;
  enabled: boolean;
  numbers: WhatsAppNumber[];
};

export type WhatsAppSendResult = { sent: string[]; failed: { phone: string; error: string }[] };

type ConnectionDoc = { enabled?: boolean; numbers?: WhatsAppNumber[] };

export async function loadWhatsApp(workspaceId: string): Promise<ConnectionDoc | null> {
  return WhatsAppConnection.findOne({ workspaceId }).select("enabled numbers").lean<ConnectionDoc>();
}

export async function whatsappStatus(workspaceId: string): Promise<WhatsAppStatus> {
  const [doc, plan] = await Promise.all([loadWhatsApp(workspaceId), currentPlan(workspaceId)]);
  return {
    available: whatsappConfigured(),
    entitled: Boolean(plan?.whatsappReports),
    planName: plan?.name ?? null,
    enabled: Boolean(doc?.enabled),
    numbers: doc?.numbers ?? [],
  };
}

export async function requireEntitled(workspaceId: string): Promise<void> {
  if (!whatsappConfigured()) throw new WhatsAppError("WhatsApp is not available right now");
  const plan = await currentPlan(workspaceId);
  if (!plan?.whatsappReports) throw new WhatsAppError(`WhatsApp is not included in the ${plan?.name ?? "current"} plan`);
}

export async function setWhatsAppEnabled(workspaceId: string, enabled: boolean): Promise<WhatsAppStatus> {
  if (enabled) await requireEntitled(workspaceId);
  await WhatsAppConnection.updateOne(
    { workspaceId },
    { $set: { enabled, ...(enabled ? { enabledAt: new Date() } : {}) } },
    { upsert: true }
  );
  return whatsappStatus(workspaceId);
}

export async function removeNumber(workspaceId: string, phone: string): Promise<WhatsAppStatus> {
  await WhatsAppConnection.updateOne({ workspaceId }, { $pull: { numbers: { phone } } });
  return whatsappStatus(workspaceId);
}

export async function setNumberFormAlerts(workspaceId: string, phone: string, on: boolean): Promise<WhatsAppStatus> {
  const result = await WhatsAppConnection.updateOne(
    { workspaceId, "numbers.phone": phone },
    { $set: { "numbers.$.formAlerts": on } }
  );
  if (!result.matchedCount) throw new WhatsAppError("That number is not on this workspace");
  return whatsappStatus(workspaceId);
}

export async function activeNumbers(workspaceId: string): Promise<WhatsAppNumber[] | null> {
  if (!whatsappConfigured()) return null;
  const [doc, plan] = await Promise.all([loadWhatsApp(workspaceId), currentPlan(workspaceId)]);
  if (!doc?.enabled || !plan?.whatsappReports) return null;
  return doc.numbers ?? [];
}

export async function sendToNumbers(numbers: WhatsAppNumber[], text: string): Promise<WhatsAppSendResult> {
  const result: WhatsAppSendResult = { sent: [], failed: [] };
  for (const n of numbers) {
    try {
      await sendWhatsApp(n.phone, text);
      result.sent.push(n.label || `+${n.phone}`);
    } catch (e) {
      result.failed.push({ phone: n.label || `+${n.phone}`, error: (e as Error).message });
    }
  }
  return result;
}

export async function sendWhatsAppTest(workspaceId: string): Promise<WhatsAppSendResult> {
  const numbers = await activeNumbers(workspaceId);
  if (!numbers) throw new WhatsAppError("Turn WhatsApp on first");
  if (!numbers.length) throw new WhatsAppError("Add a number first");
  return sendToNumbers(
    numbers,
    "*Quantalog test message*\nWhatsApp is connected. Reports and form alerts you route to this number will arrive here."
  );
}
