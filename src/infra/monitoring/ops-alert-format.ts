import { STATUS_CODES } from "node:http";
import { escapeHtml } from "../messaging/telegram.js";

export const DEFAULT_SERVICE = "Quantalog API";
export const MAX_DETAIL = 1500;
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

export function withoutQuery(path: string): string {
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

export function workspaceOf(path: string): string | undefined {
  return /\/workspaces\/([0-9a-f]{24})/i.exec(path)?.[1];
}

export function statusLabel(status: number): string {
  const text = STATUS_CODES[status];
  return text ? `${status} ${text}` : String(status);
}

export function firstAppFrame(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frame = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") && !line.includes("node_modules") && !line.includes("node:"));
  return frame?.replace(/^at /, "").replace(/\(?file:\/\/\/?.*?\/(src|dist)\//, "($1/");
}

export function presentFields(entries: [string, string | number | undefined][]): OpsAlertField[] {
  return entries
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => ({ label, value: String(value) }));
}

export function fingerprint(alert: OpsAlert): string {
  const detail = alert.detail.slice(0, 120).replace(/[0-9a-f]{24}/gi, ":id").replace(/\d+/g, "#");
  return `${alert.service ?? DEFAULT_SERVICE}|${alert.title}|${alert.where}|${detail}`.slice(0, 240);
}

export function renderOpsAlert(alert: OpsAlert, footer: { environment: string; sentAt: Date }): string {
  return [
    `<b>${escapeHtml(alert.service ?? DEFAULT_SERVICE)} · ${escapeHtml(alert.title)}</b>`,
    "",
    `<b>Where:</b> <code>${escapeHtml(alert.where)}</code>`,
    `<b>Issue:</b> ${escapeHtml(alert.detail.slice(0, MAX_DETAIL))}`,
    ...(alert.fields ?? []).map((f) => `<b>${escapeHtml(f.label)}:</b> <code>${escapeHtml(f.value)}</code>`),
    "",
    `<i>${escapeHtml(footer.environment)} · ${footer.sentAt.toISOString()}</i>`,
  ].join("\n");
}

export function opsAlertLogLine(alert: OpsAlert): string {
  const extra = (alert.fields ?? []).map((f) => `${f.label}=${f.value}`).join(" ");
  return `[ops-alert] ${alert.service ?? DEFAULT_SERVICE} | ${alert.title} | ${alert.where} | ${alert.detail}${extra ? ` | ${extra}` : ""}`;
}

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

export function serverErrorAlert(error: unknown, context: ServerErrorContext): OpsAlert {
  const e = error as { name?: string; message?: string; stack?: string; code?: unknown } | null;
  return {
    title: "Unhandled error · 500 Internal Server Error",
    where: `${context.method} ${routeShape(context.path)}`,
    detail: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`,
    fields: presentFields([
      ["Area", areaOf(context.path)],
      ["Path", withoutQuery(context.path)],
      ["Code", typeof e?.code === "string" || typeof e?.code === "number" ? e.code : undefined],
      ["Thrown at", firstAppFrame(e?.stack)],
      ["Workspace", workspaceOf(context.path)],
      ["User", context.userId],
    ]),
  };
}

export function serverResponseAlert(status: number, context: ServerResponseContext): OpsAlert {
  return {
    title: `Request failed · ${statusLabel(status)}`,
    where: `${context.method} ${routeShape(context.route ?? context.path)}`,
    detail: context.message || "The endpoint answered with an error status but no error message.",
    fields: presentFields([
      ["Area", areaOf(context.path)],
      ["Path", withoutQuery(context.path)],
      ["Workspace", workspaceOf(context.path)],
      ["User", context.userId],
      ["Took", context.durationMs !== undefined ? `${context.durationMs} ms` : undefined],
      ["Vercel request", context.requestId],
    ]),
  };
}

export function cronFailureAlert(job: string, message: string): OpsAlert {
  return { title: "Cron job failed", where: `cron · ${job}`, detail: message, fields: [{ label: "Job", value: job }] };
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
