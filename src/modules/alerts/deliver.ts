import { escapeHtml } from "../../infra/messaging/telegram.js";
import { broadcastHtml, mailConfigured, sendOne } from "../../infra/mail/mailer.js";
import { emit } from "../notifications/notify.service.js";
import { deliveryFor, sendToChats } from "../telegram/telegram.service.js";
import { activeNumbers, sendToNumbers } from "../whatsapp/whatsapp.service.js";
import { Membership, ROLE_RANK, type WorkspaceRole } from "../workspace/models/Membership.js";
import { User } from "../identity/models/User.js";
import type { AlertChannel } from "./rules.js";
import type { AlertCondition } from "./checks.js";

export type ChannelOutcome = { sent: number; failed: number; skipped?: string };
export type DeliveryReport = Partial<Record<AlertChannel | "inApp", ChannelOutcome>>;

function appUrl(path: string): string {
  return `${(process.env.APP_URL || "https://studio-quantalog.daorbit.in").replace(/\/+$/, "")}${path}`;
}

async function alertRecipients(workspaceId: string): Promise<{ email: string; name?: string }[]> {
  const memberships = await Membership.find({ workspaceId }).select("userId role").lean();
  const ids = memberships
    .filter((m) => ROLE_RANK[m.role as WorkspaceRole] >= ROLE_RANK.editor)
    .map((m) => m.userId);
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } }).select("email name").lean();
  return users.filter((u) => u.email).map((u) => ({ email: String(u.email), name: u.name ? String(u.name) : undefined }));
}

function plainText(workspaceName: string, alerts: AlertCondition[]): string {
  const blocks = alerts.map((a) => `${a.title}\n${a.summary}`);
  return [`Alerts for ${workspaceName}`, ...blocks].join("\n\n");
}

async function sendEmail(workspaceId: string, workspaceName: string, alerts: AlertCondition[]): Promise<ChannelOutcome> {
  if (!mailConfigured()) return { sent: 0, failed: 0, skipped: "Email is not configured on this server" };
  const recipients = await alertRecipients(workspaceId);
  if (!recipients.length) return { sent: 0, failed: 0, skipped: "No editors or admins to email" };

  const subject = alerts.length === 1 ? alerts[0].title : `${alerts.length} alerts for ${workspaceName}`;
  const text = plainText(workspaceName, alerts);
  const html = broadcastHtml(text, { label: "Open Quantalog", href: appUrl(alerts[0].link) });
  const settled = await Promise.allSettled(recipients.map((to) => sendOne(to, subject, text, html)));
  const failed = settled.filter((s) => s.status === "rejected").length;
  return { sent: settled.length - failed, failed };
}

async function sendTelegram(workspaceId: string, workspaceName: string, alerts: AlertCondition[]): Promise<ChannelOutcome> {
  const delivery = await deliveryFor(workspaceId);
  if (!delivery || !delivery.chats.length) return { sent: 0, failed: 0, skipped: "No Telegram chats linked" };
  const lines = alerts.map((a) => `<b>${escapeHtml(a.title)}</b>\n${escapeHtml(a.summary)}`);
  const html = [`<b>Quantalog alerts</b> · ${escapeHtml(workspaceName)}`, ...lines, `<a href="${escapeHtml(appUrl(alerts[0].link))}">Open Quantalog</a>`].join("\n\n");
  const result = await sendToChats(delivery.token, delivery.chats, html);
  return { sent: result.sent.length, failed: result.failed.length };
}

async function sendWhatsApp(workspaceId: string, workspaceName: string, alerts: AlertCondition[]): Promise<ChannelOutcome> {
  const numbers = await activeNumbers(workspaceId);
  if (!numbers?.length) return { sent: 0, failed: 0, skipped: "No verified WhatsApp numbers" };
  const lines = alerts.map((a) => `*${a.title}*\n${a.summary}`);
  const text = [`*Quantalog alerts* · ${workspaceName}`, ...lines, appUrl(alerts[0].link)].join("\n\n");
  const result = await sendToNumbers(numbers, text);
  return { sent: result.sent.length, failed: result.failed.length };
}

async function notifyInApp(workspaceId: string, alerts: AlertCondition[]): Promise<ChannelOutcome> {
  await Promise.all(
    alerts.map((a) => emit({ type: a.notification.type, workspaceId, data: a.notification.data, link: a.link })),
  );
  return { sent: alerts.length, failed: 0 };
}

function settle(outcome: Promise<ChannelOutcome>): Promise<ChannelOutcome> {
  return outcome.catch((e: unknown) => ({ sent: 0, failed: 1, skipped: e instanceof Error ? e.message : "failed" }));
}

export async function deliverAlerts(
  workspace: { id: string; name: string },
  alerts: AlertCondition[],
  channels: Record<AlertChannel, boolean>,
): Promise<DeliveryReport> {
  if (!alerts.length) return {};
  const jobs: [keyof DeliveryReport, Promise<ChannelOutcome>][] = [["inApp", settle(notifyInApp(workspace.id, alerts))]];
  if (channels.email) jobs.push(["email", settle(sendEmail(workspace.id, workspace.name, alerts))]);
  if (channels.telegram) jobs.push(["telegram", settle(sendTelegram(workspace.id, workspace.name, alerts))]);
  if (channels.whatsapp) jobs.push(["whatsapp", settle(sendWhatsApp(workspace.id, workspace.name, alerts))]);

  const outcomes = await Promise.all(jobs.map(([, job]) => job));
  return Object.fromEntries(jobs.map(([channel], i) => [channel, outcomes[i]]));
}
