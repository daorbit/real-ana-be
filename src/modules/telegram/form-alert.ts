import { escapeHtml } from "../../infra/messaging/telegram.js";
import { MAX_FIELDS, clip, type FormAlert } from "../form-alerts/alert.js";
import { deliveryFor, sendToChats, type SendResult } from "./telegram.service.js";

export function formAlertText(alert: FormAlert): string {
  const lines = alert.answers
    .slice(0, MAX_FIELDS)
    .map((a) => `<b>${escapeHtml(clip(a.label))}:</b> ${escapeHtml(clip(a.value))}`);
  return [`<b>${escapeHtml(alert.title)}</b>`, ...lines].join("\n");
}

export async function sendFormAlert(workspaceId: string, alert: FormAlert): Promise<SendResult> {
  const delivery = await deliveryFor(workspaceId);
  const chats = delivery?.chats.filter((c) => c.formAlerts) ?? [];
  if (!delivery || !chats.length) return { sent: [], failed: [] };
  return sendToChats(delivery.token, chats, formAlertText(alert));
}
