import { activeNumbers, sendToNumbers, whatsappStatus, type WhatsAppSendResult } from "../whatsapp/whatsapp.service.js";
import { MAX_FIELDS, clip, type FormAlert } from "./alert.js";

export type WhatsAppAlertSummary = {
  available: boolean;
  entitled: boolean;
  planName: string | null;
  enabled: boolean;
  alertNumbers: number;
};

export function whatsappAlertText(alert: FormAlert): string {
  const lines = alert.answers.slice(0, MAX_FIELDS).map((a) => `*${clip(a.label)}:* ${clip(a.value)}`);
  return [`*${alert.title}*`, ...lines].join("\n");
}

export async function whatsappAlertSummary(workspaceId: string): Promise<WhatsAppAlertSummary> {
  const status = await whatsappStatus(workspaceId);
  return {
    available: status.available,
    entitled: status.entitled,
    planName: status.planName,
    enabled: status.enabled,
    alertNumbers: status.numbers.filter((n) => n.formAlerts).length,
  };
}

export async function sendWhatsAppAlert(workspaceId: string, alert: FormAlert): Promise<WhatsAppSendResult> {
  const numbers = (await activeNumbers(workspaceId))?.filter((n) => n.formAlerts) ?? [];
  if (!numbers.length) return { sent: [], failed: [] };
  return sendToNumbers(numbers, whatsappAlertText(alert));
}
