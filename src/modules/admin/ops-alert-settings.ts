import { AppSetting, SETTING_OPS_ALERTS } from "../../config/AppSetting.js";
import { encryptSecret, readStoredSecret } from "../../shared/utils/crypto-box.js";
import { withTimeout } from "../../shared/utils/with-timeout.js";
import { isBotToken, platformBotToken } from "../../infra/messaging/telegram.js";
import { AppError } from "../../shared/errors/index.js";

export type OpsAlertTarget = { token: string; chatId: string };

export type OpsAlertSettingsView = {
  enabled: boolean;
  chatId: string;
  botTokenMask: string | null;
  usesPlatformBot: boolean;
  envConfigured: boolean;
};

type StoredOpsAlerts = { enabled?: boolean; chatId?: string; botToken?: string };

const CACHE_MS = 60_000;
const READ_TIMEOUT_MS = 1500;
const CHAT_ID_RE = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

let cached: { at: number; value: Promise<StoredOpsAlerts> } | null = null;

async function loadStored(): Promise<StoredOpsAlerts> {
  const row = await AppSetting.findOne({ key: SETTING_OPS_ALERTS }).select("value").lean();
  const value = row?.value;
  return value && typeof value === "object" ? (value as StoredOpsAlerts) : {};
}

function stored(): Promise<StoredOpsAlerts> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = loadStored();
  cached = { at: Date.now(), value };
  value.catch(() => {
    cached = null;
  });
  return value;
}

function envTarget(): OpsAlertTarget | null {
  const chatId = process.env.OPS_ALERT_TELEGRAM_CHAT_ID?.trim();
  const own = process.env.OPS_ALERT_TELEGRAM_BOT_TOKEN?.trim();
  const token = own && isBotToken(own) ? own : platformBotToken();
  return chatId && token ? { token, chatId } : null;
}

function storedToken(settings: StoredOpsAlerts): string | null {
  const secret = readStoredSecret(settings.botToken);
  return secret.ok ? secret.value : null;
}

function savedTarget(settings: StoredOpsAlerts): OpsAlertTarget | null {
  if (!settings.chatId) return null;
  const token = storedToken(settings) ?? platformBotToken();
  return token ? { token, chatId: settings.chatId } : null;
}

export async function resolveOpsAlertTarget(): Promise<OpsAlertTarget | null> {
  const settings = await withTimeout<StoredOpsAlerts | null>(stored(), READ_TIMEOUT_MS, null);
  if (!settings) return envTarget();
  if (settings.enabled === false) return null;
  return savedTarget(settings) ?? envTarget();
}

function maskTail(value: string): string {
  return `••••${value.slice(-4)}`;
}

function toView(settings: StoredOpsAlerts): OpsAlertSettingsView {
  const token = storedToken(settings);
  return {
    enabled: settings.enabled !== false,
    chatId: settings.chatId ?? "",
    botTokenMask: token ? maskTail(token) : null,
    usesPlatformBot: !token && platformBotToken() !== null,
    envConfigured: envTarget() !== null,
  };
}

export async function getOpsAlertSettings(): Promise<OpsAlertSettingsView> {
  return toView(await loadStored());
}

export async function setOpsAlertSettings(patch: {
  enabled?: unknown;
  chatId?: unknown;
  botToken?: unknown;
  clearBotToken?: unknown;
}): Promise<OpsAlertSettingsView> {
  const current = await loadStored();
  const next: StoredOpsAlerts = { ...current };

  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;

  if (typeof patch.chatId === "string") {
    const chatId = patch.chatId.trim();
    if (chatId && !CHAT_ID_RE.test(chatId)) throw new AppError(400, "That chat id is not valid");
    next.chatId = chatId;
  }

  if (patch.clearBotToken === true) {
    delete next.botToken;
  } else if (typeof patch.botToken === "string" && patch.botToken.trim()) {
    const token = patch.botToken.trim();
    if (!isBotToken(token)) throw new AppError(400, "That bot token is not valid");
    next.botToken = encryptSecret(token);
  }

  await AppSetting.updateOne({ key: SETTING_OPS_ALERTS }, { $set: { value: next } }, { upsert: true });
  cached = null;
  return toView(next);
}
