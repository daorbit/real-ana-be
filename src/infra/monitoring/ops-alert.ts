import { STATUS_CODES } from "node:http";
import { escapeHtml, sendTelegram } from "../messaging/telegram.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { resolveOpsAlertTarget, type OpsAlertTarget } from "../../modules/admin/ops-alert-settings.js";
import { withTimeout } from "../../shared/utils/with-timeout.js";

const DEFAULT_SERVICE = "Quantalog API";
const COOLDOWN_MS = 10 * 60 * 1000;
const SHARED_CHECK_TIMEOUT_MS = 1500;
const MAX_TRACKED = 500;
const MAX_DETAIL = 1500;
const MAX_FIELDS = 12;
const MAX_LABEL = 40;
const MAX_VALUE = 400;

export type OpsAlertField = { label: string; value: string };

export type OpsAlert = {
  service?: string;
  title: string;
  where: string;
  detail: string;
  fields?: OpsAlertField[];
};

export type ServerResponseContext = {
  method: string;
  path: string;
  route?: string;
  message?: string;
  userId?: string;
  durationMs?: number;
  requestId?: string;
};

export type ServerErrorContext = {
  method: string;
  path: string;
  userId?: string;
};

const lastSent = new Map<string, number>();

function environment(): string {
  return process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}

function withoutQuery(path: string): string {
  return path.split("?")[0];
}

export function routeShape(path: string): string {
  return withoutQuery(path)
    .split("/")
    .map((part) => (/^[0-9a-f]{24}$/i.test(part) || /^\d+$/.test(part) ? ":id" : part))
    .join("/");
}

export function areaOf(path: string): string {
  const parts = withoutQuery(path).split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  if (parts[0] === "workspaces" && parts.length > 2) return `workspaces · ${parts[2]}`;
  if (parts[0] === "internal" && parts[1]) return `internal · ${parts[1]}${parts[2] ? ` · ${parts[2]}` : ""}`;
  return parts[0] ?? "root";
}

function workspaceOf(path: string): string | undefined {
  return /\/workspaces\/([0-9a-f]{24})/i.exec(path)?.[1];
}

export function statusLabel(status: number): string {
  const text = STATUS_CODES[status];
  return text ? `${status} ${text}` : String(status);
}

function firstAppFrame(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frame = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") && !line.includes("node_modules") && !line.includes("node:"));
  return frame?.replace(/^at /, "").replace(/\(?file:\/\/\/?.*?\/(src|dist)\//, "($1/");
}

function field(label: string, value: string | number | undefined): OpsAlertField | null {
  if (value === undefined || value === "") return null;
  return { label, value: String(value) };
}

function present(fields: (OpsAlertField | null)[]): OpsAlertField[] {
  return fields.filter((f): f is OpsAlertField => f !== null);
}

function fingerprint(alert: OpsAlert): string {
  const detail = alert.detail.slice(0, 120).replace(/[0-9a-f]{24}/gi, ":id").replace(/\d+/g, "#");
  return `${alert.service ?? DEFAULT_SERVICE}|${alert.title}|${alert.where}|${detail}`.slice(0, 240);
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
  const lines = [
    `<b>${escapeHtml(alert.service ?? DEFAULT_SERVICE)} · ${escapeHtml(alert.title)}</b>`,
    "",
    `<b>Where:</b> <code>${escapeHtml(alert.where)}</code>`,
    `<b>Issue:</b> ${escapeHtml(alert.detail.slice(0, MAX_DETAIL))}`,
    ...(alert.fields ?? []).map((f) => `<b>${escapeHtml(f.label)}:</b> <code>${escapeHtml(f.value)}</code>`),
    "",
    `<i>${escapeHtml(environment())} · ${new Date().toISOString()}</i>`,
  ];
  return lines.join("\n");
}

function logLine(alert: OpsAlert): string {
  const extra = (alert.fields ?? []).map((f) => `${f.label}=${f.value}`).join(" ");
  return `[ops-alert] ${alert.service ?? DEFAULT_SERVICE} | ${alert.title} | ${alert.where} | ${alert.detail}${extra ? ` | ${extra}` : ""}`;
}

async function deliver(target: OpsAlertTarget, alert: OpsAlert): Promise<void> {
  await sendTelegram(target.token, target.chatId, render(alert));
}

export async function sendOpsAlert(alert: OpsAlert): Promise<void> {
  console.error(logLine(alert));
  const key = fingerprint(alert);
  if (coolingDownHere(key)) return;
  const target = await resolveOpsAlertTarget();
  if (!target) {
    console.warn("[ops-alert] not sent: alerts are off or no chat is configured");
    return;
  }
  if (await coolingDownEverywhere(key)) return;
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
    where: "Admin → System alerts",
    detail: "Alerts are set up. Failures will be posted here.",
  });
  return true;
}

export function alertServerError(error: unknown, context: ServerErrorContext): Promise<void> {
  const e = error as { name?: string; message?: string; stack?: string; code?: unknown } | null;
  return sendOpsAlert({
    title: "Unhandled error · 500 Internal Server Error",
    where: `${context.method} ${routeShape(context.path)}`,
    detail: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`,
    fields: present([
      field("Area", areaOf(context.path)),
      field("Path", withoutQuery(context.path)),
      field("Code", typeof e?.code === "string" || typeof e?.code === "number" ? e.code : undefined),
      field("Thrown at", firstAppFrame(e?.stack)),
      field("Workspace", workspaceOf(context.path)),
      field("User", context.userId),
    ]),
  });
}

export function alertServerResponse(status: number, context: ServerResponseContext): Promise<void> {
  return sendOpsAlert({
    title: `Request failed · ${statusLabel(status)}`,
    where: `${context.method} ${context.route ?? routeShape(context.path)}`,
    detail: context.message || "The endpoint answered with an error status but no error message.",
    fields: present([
      field("Area", areaOf(context.path)),
      field("Path", withoutQuery(context.path)),
      field("Workspace", workspaceOf(context.path)),
      field("User", context.userId),
      field("Took", context.durationMs !== undefined ? `${context.durationMs} ms` : undefined),
      field("Vercel request", context.requestId),
    ]),
  });
}

export function alertCronFailure(job: string, message: string): Promise<void> {
  return sendOpsAlert({
    title: "Cron job failed",
    where: `cron · ${job}`,
    detail: message,
    fields: [{ label: "Job", value: job }],
  });
}

function parseFields(value: unknown): OpsAlertField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields = value
    .slice(0, MAX_FIELDS)
    .map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const label = typeof entry.label === "string" ? entry.label.trim().slice(0, MAX_LABEL) : "";
      const text = typeof entry.value === "string" ? entry.value.trim().slice(0, MAX_VALUE) : "";
      return label && text ? { label, value: text } : null;
    })
    .filter((f): f is OpsAlertField => f !== null);
  return fields.length ? fields : undefined;
}

export function parseRelayedAlert(body: unknown, service: string): OpsAlert | null {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const title = text(input.title, 80);
  const where = text(input.where, 200);
  const detail = text(input.detail, MAX_DETAIL);
  if (!title || !where || !detail) return null;
  return { service: text(input.service, 40) || service, title, where, detail, fields: parseFields(input.fields) };
}
