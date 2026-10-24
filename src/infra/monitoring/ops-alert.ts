import { sendTelegram } from "../messaging/telegram.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { resolveOpsAlertTarget, type OpsAlertTarget } from "../../modules/admin/ops-alert-settings.js";
import { withTimeout } from "../../shared/utils/with-timeout.js";
import {
  cronFailureAlert,
  fingerprint,
  opsAlertLogLine,
  renderOpsAlert,
  serverErrorAlert,
  serverResponseAlert,
  type OpsAlert,
  type ServerErrorContext,
  type ServerResponseContext,
} from "./ops-alert-format.js";

export { parseRelayedAlert, routeShape, type OpsAlert } from "./ops-alert-format.js";

const COOLDOWN_MS = 10 * 60 * 1000;
const SHARED_CHECK_TIMEOUT_MS = 1500;
const MAX_TRACKED = 500;

const lastSent = new Map<string, number>();

function environment(): string {
  return process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
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

async function deliver(target: OpsAlertTarget, alert: OpsAlert): Promise<void> {
  await sendTelegram(target.token, target.chatId, renderOpsAlert(alert, { environment: environment(), sentAt: new Date() }));
}

export async function sendOpsAlert(alert: OpsAlert): Promise<void> {
  console.error(opsAlertLogLine(alert));
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
  return sendOpsAlert(serverErrorAlert(error, context));
}

export function alertServerResponse(status: number, context: ServerResponseContext): Promise<void> {
  return sendOpsAlert(serverResponseAlert(status, context));
}

export function alertCronFailure(job: string, message: string): Promise<void> {
  return sendOpsAlert(cronFailureAlert(job, message));
}
