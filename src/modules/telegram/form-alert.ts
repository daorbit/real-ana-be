import { escapeHtml } from "../../infra/messaging/telegram.js";
import { deliveryFor, sendToChats, type SendResult } from "./telegram.service.js";

const MAX_FIELDS = 12;
const MAX_VALUE = 300;

export type FormAlert = { title: string; answers: { label: string; value: string }[] };

function clip(value: string): string {
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
}

export function formAlertText(alert: FormAlert): string {
  const lines = alert.answers
    .slice(0, MAX_FIELDS)
    .map((a) => `<b>${escapeHtml(clip(a.label))}:</b> ${escapeHtml(clip(a.value))}`);
  return [`<b>${escapeHtml(alert.title)}</b>`, ...lines].join("\n");
}

export function parseFormAlert(body: unknown): FormAlert | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
  if (!title) return null;
  const answers = (Array.isArray(raw.answers) ? raw.answers : [])
    .map((a) => {
      if (!a || typeof a !== "object") return null;
      const row = a as Record<string, unknown>;
      const label = typeof row.label === "string" ? row.label.slice(0, 120) : "";
      const value = typeof row.value === "string" ? row.value.slice(0, 500) : "";
      return label ? { label, value } : null;
    })
    .filter((a): a is { label: string; value: string } => a !== null)
    .slice(0, MAX_FIELDS);
  return { title, answers };
}

export async function sendFormAlert(workspaceId: string, alert: FormAlert): Promise<SendResult> {
  const delivery = await deliveryFor(workspaceId);
  const chats = delivery?.chats.filter((c) => c.formAlerts) ?? [];
  if (!delivery || !chats.length) return { sent: [], failed: [] };
  return sendToChats(delivery.token, chats, formAlertText(alert));
}
