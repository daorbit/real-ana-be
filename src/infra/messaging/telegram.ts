import axios from "axios";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";

const API_BASE = "https://api.telegram.org";
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const MAX_TEXT = 4000;

export type TelegramChatInfo = {
  chatId: string;
  title: string;
  type: string;
};

type RawChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type RawUpdate = {
  message?: { chat: RawChat };
  edited_message?: { chat: RawChat };
  channel_post?: { chat: RawChat };
  my_chat_member?: { chat: RawChat };
};

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

const usernames = createTtlCache<string>(60 * 60 * 1000, 200);

export function platformBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token && TOKEN_RE.test(token) ? token : null;
}

export function telegramConfigured(): boolean {
  return platformBotToken() !== null;
}

export function isBotToken(raw: string): boolean {
  return TOKEN_RE.test(raw.trim());
}

function describe(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const status = e.response?.status;
    const description = (e.response?.data as { description?: string } | undefined)?.description;
    if (status === 401 || status === 404) return "Telegram does not recognise this bot token";
    if (status === 403) return "The bot was blocked or removed from this chat";
    if (status === 409) return "This bot has a webhook set, so its chats cannot be listed here";
    if (description) return `Telegram: ${description}`;
    if (e.code === "ECONNABORTED") return "Telegram did not answer in time";
    return status ? `Telegram returned HTTP ${status}` : e.message;
  }
  return (e as Error).message;
}

async function call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  try {
    const { data } = await axios.post(`${API_BASE}/bot${token}/${method}`, body ?? {}, { timeout: 10_000 });
    if (!data?.ok) throw new TelegramError(data?.description ? `Telegram: ${data.description}` : "Telegram refused the request");
    return data.result as T;
  } catch (e) {
    if (e instanceof TelegramError) throw e;
    throw new TelegramError(describe(e));
  }
}

function chatTitle(chat: RawChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  if (name) return name;
  return chat.username ? `@${chat.username}` : String(chat.id);
}

export function toChatInfo(chat: RawChat): TelegramChatInfo {
  return { chatId: String(chat.id), title: chatTitle(chat).slice(0, 120), type: chat.type };
}

export async function botUsername(token: string): Promise<string> {
  const configured = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (configured && token === platformBotToken()) return configured;
  return usernames(token, async () => {
    const me = await call<{ username?: string }>(token, "getMe");
    if (!me.username) throw new TelegramError("This bot has no username");
    return me.username;
  });
}

export async function recentChats(token: string, limit = 20): Promise<TelegramChatInfo[]> {
  const updates = await call<RawUpdate[]>(token, "getUpdates");
  const byId = new Map<string, TelegramChatInfo>();
  for (const update of [...updates].reverse()) {
    const chat =
      update.message?.chat ?? update.edited_message?.chat ?? update.channel_post?.chat ?? update.my_chat_member?.chat;
    if (!chat) continue;
    const info = toChatInfo(chat);
    if (!byId.has(info.chatId)) byId.set(info.chatId, info);
    if (byId.size >= limit) break;
  }
  return [...byId.values()];
}

export async function chatInfo(token: string, chatId: string): Promise<TelegramChatInfo> {
  const chat = await call<RawChat>(token, "getChat", { chat_id: chatId });
  return toChatInfo(chat);
}

export async function sendTelegram(token: string, chatId: string, html: string): Promise<void> {
  const text = html.length > MAX_TEXT ? `${html.slice(0, MAX_TEXT)}…` : html;
  await call(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
