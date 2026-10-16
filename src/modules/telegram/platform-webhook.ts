import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import {
  TelegramError,
  platformBotToken,
  platformWebhookSecret,
  setWebhook,
  webhookUrl,
} from "../../infra/messaging/telegram.js";

const WEBHOOK_PATH = "/api/webhooks/telegram";
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;

const checked = createTtlCache<true>(CHECK_TTL_MS, 4);

function apiBase(): string {
  return (process.env.API_URL || process.env.PUBLIC_BASE_URL || "https://quantalog-be.daorbit.in").replace(/\/+$/, "");
}

export function platformWebhookTarget(): string {
  return `${apiBase()}${WEBHOOK_PATH}`;
}

export async function ensurePlatformWebhook(): Promise<void> {
  const token = platformBotToken();
  const secret = platformWebhookSecret();
  if (!token || !secret) throw new TelegramError("Telegram delivery is not set up on this server");
  const target = platformWebhookTarget();
  if (!target.startsWith("https://")) return;
  await checked(target, async () => {
    if ((await webhookUrl(token)) !== target) await setWebhook(token, target, secret);
    return true;
  });
}
