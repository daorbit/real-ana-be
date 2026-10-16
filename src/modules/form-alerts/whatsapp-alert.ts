import { Membership } from "../workspace/models/Membership.js";
import { User } from "../identity/models/User.js";
import { currentPlan } from "../billing/quota.service.js";
import { normalizePhone, sendWhatsApp, whatsappConfigured } from "../../infra/messaging/whatsapp.js";
import { MAX_FIELDS, clip, type FormAlert } from "./alert.js";

export type WhatsAppAlertSummary = {
  configured: boolean;
  entitled: boolean;
  planName: string | null;
  mobileHint: string | null;
};

export type WhatsAppAlertResult = { sent: boolean; error?: string };

async function ownerMobile(workspaceId: string): Promise<string | null> {
  const owner = await Membership.findOne({ workspaceId, role: "owner" }).select("userId").lean<{ userId: unknown }>();
  if (!owner) return null;
  const user = await User.findById(owner.userId).select("mobile").lean<{ mobile?: string }>();
  return normalizePhone(user?.mobile ?? "");
}

function hint(phone: string): string {
  return `••••• ${phone.slice(-4)}`;
}

export function whatsappAlertText(alert: FormAlert): string {
  const lines = alert.answers.slice(0, MAX_FIELDS).map((a) => `*${clip(a.label)}:* ${clip(a.value)}`);
  return [`*${alert.title}*`, ...lines].join("\n");
}

export async function whatsappAlertSummary(workspaceId: string): Promise<WhatsAppAlertSummary> {
  const [plan, mobile] = await Promise.all([currentPlan(workspaceId), ownerMobile(workspaceId)]);
  return {
    configured: whatsappConfigured(),
    entitled: Boolean(plan?.whatsappReports),
    planName: plan?.name ?? null,
    mobileHint: mobile ? hint(mobile) : null,
  };
}

export async function sendWhatsAppAlert(workspaceId: string, alert: FormAlert): Promise<WhatsAppAlertResult> {
  if (!whatsappConfigured()) return { sent: false, error: "WhatsApp is not configured" };
  const [plan, mobile] = await Promise.all([currentPlan(workspaceId), ownerMobile(workspaceId)]);
  if (!plan?.whatsappReports) return { sent: false, error: "WhatsApp alerts are not on this plan" };
  if (!mobile) return { sent: false, error: "the workspace owner has no mobile number" };
  try {
    await sendWhatsApp(mobile, whatsappAlertText(alert));
    return { sent: true };
  } catch (e) {
    return { sent: false, error: (e as Error).message };
  }
}
