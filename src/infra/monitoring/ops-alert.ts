import { escapeHtml, sendTelegram } from "../messaging/telegram.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { resolveOpsAlertTarget, type OpsAlertTarget } from "../../modules/admin/ops-alert-settings.js";
import { withTimeout } from "../../shared/utils/with-timeout.js";

const DEFAULT_SERVICE = "Quantalog API";
const COOLDOWN_MS = 10 * 60 * 1000;
const SHARED_CHECK_TIMEOUT_MS = 1500;
const MAX_TRACKED = 500;
const MAX_DETAIL = 1500;

export type OpsAlert = { service?: string; title: string; where: string; detail: string };

const lastSent = new Map<string, number>();

function environment(): string {
  return process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}

export function routeShape(path: string): string {
  return path
    .split("/")
    .map((part) => (/^[0-9a-f]{24}$/i.test(part) || /^\d+$/.test(part) ? ":id" : part))
    .join("/");
}

function fingerprint(alert: OpsAlert): string {
  const detail = alert.detail.slice(0, 120).replace(/[0-9a-f]{24}/gi, ":id").replace(/\d+/g, "#");
  return `${alert.service ?? DEFAULT_SERVICE}|${alert.where}|${detail}`.slice(0, 240);
}

function coolingDownHere(key: string): boolean {
  const now = Date.now();
  const last = lastSent.get(key);
  if (last && now - last < COOLDOWN_MS) return true;
  if (lastSent.size >= MAX_TRACKED) lastSent.clear();
  lastSent.set(key, now);
  return false;
}

function coolingDownEverywhere(key: string): Promise<boolean> {
  return withTimeout(overRateLimit(`ops-alert:${key}`, 1, COOLDOWN_MS), SHARED_CHECK_TIMEOUT_MS, false);
}

function render(alert: OpsAlert): string {
  return [
    `<b>${escapeHtml(alert.service ?? DEFAULT_SERVICE)} · ${escapeHtml(alert.title)}</b>`,
    `<code>${escapeHtml(alert.where)}</code>`,
    escapeHtml(alert.detail.slice(0, MAX_DETAIL)),
    `<i>${escapeHtml(environment())} · ${new Date().toISOString()}</i>`,
  ].join("\n");
}

async function deliver(target: OpsAlertTarget, alert: OpsAlert): Promise<void> {
  await sendTelegram(target.token, target.chatId, render(alert));
}

export async function sendOpsAlert(alert: OpsAlert): Promise<void> {
  const key = fingerprint(alert);
  if (coolingDownHere(key)) return;
  const target = await resolveOpsAlertTarget();
  if (!target || (await coolingDownEverywhere(key))) return;
  try {
    await deliver(target, alert);
  } catch (e) {
    console.error("[ops-alert] telegram send failed:", (e as Error).message);
  }
}

export async function sendOpsTestAlert(): Promise<boolean> {
  const target = await resolveOpsAlertTarget();
  if (!target) return false;
  await deliver(target, {
    title: "Test alert",
    where: "admin",
    detail: "Alerts are set up. Failures will be posted here.",
  });
  return true;
}

export function alertServerError(error: unknown, context: { method: string; path: string }): Promise<void> {
  const e = error as { name?: string; message?: string } | null;
  return sendOpsAlert({
    title: "Server error",
    where: `${context.method} ${routeShape(context.path)}`,
    detail: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`,
  });
}

export function alertCronFailure(job: string, message: string): Promise<void> {
  return sendOpsAlert({ title: "Cron job failed", where: `cron ${job}`, detail: message });
}

export function parseRelayedAlert(body: unknown, service: string): OpsAlert | null {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const title = text(input.title, 80);
  const where = text(input.where, 200);
  const detail = text(input.detail, MAX_DETAIL);
  if (!title || !where || !detail) return null;
  return { service: text(input.service, 40) || service, title, where, detail };
}
