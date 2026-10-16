import { nanoid } from "nanoid";
import { TelegramConnection, type TelegramVia } from "./models/TelegramConnection.js";
import { TelegramLink } from "./models/TelegramLink.js";
import { ensurePlatformWebhook } from "./platform-webhook.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";
import {
  TelegramError,
  botUsername,
  chatInfo,
  isBotToken,
  platformBotToken,
  recentChats,
  sendTelegram,
  telegramConfigured,
  type TelegramChatInfo,
} from "../../infra/messaging/telegram.js";

export const MAX_CHATS = 20;
const LINK_TTL_MS = 30 * 60 * 1000;
const TEST_MESSAGE =
  "<b>Quantalog test message</b>\nTelegram is connected. Reports and form alerts you route to this chat will arrive here.";

export { TelegramError };

export type StoredChat = TelegramChatInfo & { via: TelegramVia; formAlerts?: boolean; linkedAt: Date };

export type TelegramStatus = {
  platformAvailable: boolean;
  platformBot: string | null;
  ownBot: { username: string } | null;
  mode: TelegramVia;
  chats: { chatId: string; title: string; type: string; formAlerts: boolean; linkedAt: Date }[];
};

export type TelegramDelivery = { token: string; chats: StoredChat[] };

export type SendResult = { sent: string[]; failed: { chat: string; error: string }[] };

type ConnectionDoc = {
  ownBot?: { tokenEnc?: string; username?: string };
  chats?: StoredChat[];
};

function modeOf(doc: ConnectionDoc | null): TelegramVia {
  return doc?.ownBot?.tokenEnc ? "own" : "quantalog";
}

function ownToken(doc: ConnectionDoc | null): string | null {
  const enc = doc?.ownBot?.tokenEnc;
  return enc ? decryptSecret(enc) : null;
}

function activeChats(doc: ConnectionDoc | null): StoredChat[] {
  const mode = modeOf(doc);
  return (doc?.chats ?? []).filter((c) => c.via === mode);
}

async function loadConnection(workspaceId: string): Promise<ConnectionDoc | null> {
  return TelegramConnection.findOne({ workspaceId }).select("ownBot chats").lean<ConnectionDoc>();
}

export async function platformUsername(): Promise<string | null> {
  const token = platformBotToken();
  if (!token || !telegramConfigured()) return null;
  try {
    return await botUsername(token);
  } catch {
    return null;
  }
}

export async function telegramStatus(workspaceId: string): Promise<TelegramStatus> {
  const [doc, platformBot] = await Promise.all([loadConnection(workspaceId), platformUsername()]);
  return {
    platformAvailable: Boolean(platformBot),
    platformBot,
    ownBot: doc?.ownBot?.tokenEnc ? { username: doc.ownBot.username ?? "" } : null,
    mode: modeOf(doc),
    chats: activeChats(doc).map((c) => ({
      chatId: c.chatId,
      title: c.title,
      type: c.type,
      formAlerts: Boolean(c.formAlerts),
      linkedAt: c.linkedAt,
    })),
  };
}

export async function createLinkUrl(workspaceId: string, group: boolean): Promise<{ url: string; expiresAt: Date }> {
  const [username, doc] = await Promise.all([platformUsername(), loadConnection(workspaceId)]);
  if (!username) throw new TelegramError("Telegram delivery is not set up on this server");
  if (modeOf(doc) === "own") throw new TelegramError("This workspace sends through its own bot. Add chats from that bot instead.");
  const code = nanoid(24);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await Promise.all([ensurePlatformWebhook(), TelegramLink.create({ code, workspaceId, expiresAt })]);
  return { url: `https://t.me/${username}?${group ? "startgroup" : "start"}=${code}`, expiresAt };
}

export async function addChat(
  workspaceId: string,
  chat: TelegramChatInfo,
  via: TelegramVia,
  formAlerts = false
): Promise<boolean> {
  const doc = await loadConnection(workspaceId);
  const chats = doc?.chats ?? [];
  if (chats.some((c) => c.chatId === chat.chatId && c.via === via)) {
    await TelegramConnection.updateOne(
      { workspaceId, chats: { $elemMatch: { chatId: chat.chatId, via } } },
      { $set: { "chats.$.title": chat.title, "chats.$.type": chat.type, ...(formAlerts ? { "chats.$.formAlerts": true } : {}) } }
    );
    return true;
  }
  if (chats.filter((c) => c.via === via).length >= MAX_CHATS) return false;
  await TelegramConnection.updateOne(
    { workspaceId },
    { $push: { chats: { ...chat, via, formAlerts, linkedAt: new Date() } } },
    { upsert: true }
  );
  return true;
}

export async function setOwnBot(workspaceId: string, token: string): Promise<TelegramStatus> {
  const trimmed = token.trim();
  if (!isBotToken(trimmed)) throw new TelegramError("That does not look like a bot token. It should look like 123456789:AAH…");
  if (trimmed === platformBotToken()) throw new TelegramError("That is the Quantalog bot. Paste a token for a bot you created.");
  const username = await botUsername(trimmed);
  await TelegramConnection.updateOne(
    { workspaceId },
    {
      $set: { ownBot: { tokenEnc: encryptSecret(trimmed), username } },
      $pull: { chats: { via: "own" } },
    },
    { upsert: true }
  );
  return telegramStatus(workspaceId);
}

export async function removeOwnBot(workspaceId: string): Promise<TelegramStatus> {
  await TelegramConnection.updateOne({ workspaceId }, { $unset: { ownBot: 1 }, $pull: { chats: { via: "own" } } });
  return telegramStatus(workspaceId);
}

async function requireOwnToken(workspaceId: string): Promise<{ token: string; doc: ConnectionDoc | null }> {
  const doc = await loadConnection(workspaceId);
  const token = ownToken(doc);
  if (!token) throw new TelegramError("Connect your own bot first");
  return { token, doc };
}

export async function findOwnChats(workspaceId: string): Promise<TelegramChatInfo[]> {
  const { token, doc } = await requireOwnToken(workspaceId);
  const linked = new Set((doc?.chats ?? []).filter((c) => c.via === "own").map((c) => c.chatId));
  const chats = await recentChats(token);
  return chats.filter((c) => !linked.has(c.chatId));
}

export async function addOwnChat(workspaceId: string, chatId: string): Promise<TelegramStatus> {
  const { token } = await requireOwnToken(workspaceId);
  const info = await chatInfo(token, chatId.trim());
  if (!(await addChat(workspaceId, info, "own"))) throw new TelegramError(`You can link up to ${MAX_CHATS} chats`);
  return telegramStatus(workspaceId);
}

export async function removeChat(workspaceId: string, chatId: string): Promise<TelegramStatus> {
  const doc = await loadConnection(workspaceId);
  await TelegramConnection.updateOne({ workspaceId }, { $pull: { chats: { chatId, via: modeOf(doc) } } });
  return telegramStatus(workspaceId);
}

export async function setFormAlerts(workspaceId: string, chatId: string, on: boolean): Promise<TelegramStatus> {
  const doc = await loadConnection(workspaceId);
  const result = await TelegramConnection.updateOne(
    { workspaceId, chats: { $elemMatch: { chatId, via: modeOf(doc) } } },
    { $set: { "chats.$.formAlerts": on } }
  );
  if (!result.matchedCount) throw new TelegramError("That chat is not linked to this workspace");
  return telegramStatus(workspaceId);
}

export async function deliveryFor(workspaceId: string): Promise<TelegramDelivery | null> {
  const doc = await loadConnection(workspaceId);
  const token = modeOf(doc) === "own" ? ownToken(doc) : platformBotToken();
  if (!token) return null;
  return { token, chats: activeChats(doc) };
}

export async function sendToChats(token: string, chats: StoredChat[], html: string): Promise<SendResult> {
  const settled = await Promise.allSettled(chats.map((c) => sendTelegram(token, c.chatId, html)));
  const result: SendResult = { sent: [], failed: [] };
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") result.sent.push(chats[i].title);
    else result.failed.push({ chat: chats[i].title, error: (s.reason as Error).message });
  });
  return result;
}

export async function sendTestMessage(workspaceId: string): Promise<SendResult> {
  const delivery = await deliveryFor(workspaceId);
  if (!delivery) throw new TelegramError("Telegram is not connected");
  if (!delivery.chats.length) throw new TelegramError("Link a chat first");
  return sendToChats(delivery.token, delivery.chats, TEST_MESSAGE);
}

export async function importOwnBot(
  workspaceId: string,
  token: string,
  chatId: string,
  formAlerts: boolean
): Promise<"imported" | "conflict"> {
  const trimmed = token.trim();
  if (!isBotToken(trimmed)) throw new TelegramError("invalid bot token");
  const doc = await loadConnection(workspaceId);
  const existing = ownToken(doc);
  if (existing && existing !== trimmed) return "conflict";
  if (!existing && (doc?.chats ?? []).some((c) => c.via === "quantalog")) return "conflict";
  const [username, info] = await Promise.all([botUsername(trimmed), chatInfo(trimmed, chatId.trim())]);
  if (!existing) {
    await TelegramConnection.updateOne(
      { workspaceId },
      { $set: { ownBot: { tokenEnc: encryptSecret(trimmed), username } } },
      { upsert: true }
    );
  }
  return (await addChat(workspaceId, info, "own", formAlerts)) ? "imported" : "conflict";
}
