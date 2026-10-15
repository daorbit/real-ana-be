import { nanoid } from "nanoid";
import { TelegramConnection, type TelegramVia } from "./models/TelegramConnection.js";
import { TelegramLink } from "./models/TelegramLink.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { decryptSecret, encryptSecret } from "../../shared/utils/crypto-box.js";
import {
  TelegramError,
  botUsername,
  chatInfo,
  escapeHtml,
  isBotToken,
  platformBotToken,
  recentChats,
  sendTelegram,
  toChatInfo,
  type TelegramChatInfo,
} from "../../infra/messaging/telegram.js";

const MAX_CHATS = 20;
const LINK_TTL_MS = 30 * 60 * 1000;
const START_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;
const STOP_RE = /^\/stop(?:@\w+)?\s*$/;
const BARE_START_RE = /^\/start(?:@\w+)?\s*$/;

export { TelegramError };

type StoredChat = TelegramChatInfo & { via: TelegramVia; linkedAt: Date };

export type TelegramStatus = {
  platformAvailable: boolean;
  platformBot: string | null;
  ownBot: { username: string } | null;
  mode: TelegramVia;
  chats: { chatId: string; title: string; type: string; linkedAt: Date }[];
};

export type TelegramDelivery = { token: string; chats: StoredChat[] };

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

async function loadConnection(workspaceId: string): Promise<ConnectionDoc | null> {
  return TelegramConnection.findOne({ workspaceId }).select("ownBot chats").lean<ConnectionDoc>();
}

async function platformUsername(): Promise<string | null> {
  const token = platformBotToken();
  if (!token) return null;
  try {
    return await botUsername(token);
  } catch {
    return null;
  }
}

export async function telegramStatus(workspaceId: string): Promise<TelegramStatus> {
  const [doc, platformBot] = await Promise.all([loadConnection(workspaceId), platformUsername()]);
  const mode = modeOf(doc);
  return {
    platformAvailable: Boolean(platformBot),
    platformBot,
    ownBot: doc?.ownBot?.tokenEnc ? { username: doc.ownBot.username ?? "" } : null,
    mode,
    chats: (doc?.chats ?? [])
      .filter((c) => c.via === mode)
      .map((c) => ({ chatId: c.chatId, title: c.title, type: c.type, linkedAt: c.linkedAt })),
  };
}

export async function createLinkUrl(workspaceId: string, group: boolean): Promise<{ url: string; expiresAt: Date }> {
  const username = await platformUsername();
  if (!username) throw new TelegramError("Telegram delivery is not set up on this server");
  const code = nanoid(24);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await TelegramLink.create({ code, workspaceId, expiresAt });
  return { url: `https://t.me/${username}?${group ? "startgroup" : "start"}=${code}`, expiresAt };
}

async function addChat(workspaceId: string, chat: TelegramChatInfo, via: TelegramVia): Promise<boolean> {
  const doc = await loadConnection(workspaceId);
  const chats = doc?.chats ?? [];
  if (chats.some((c) => c.chatId === chat.chatId && c.via === via)) {
    await TelegramConnection.updateOne(
      { workspaceId, chats: { $elemMatch: { chatId: chat.chatId, via } } },
      { $set: { "chats.$.title": chat.title, "chats.$.type": chat.type } }
    );
    return true;
  }
  if (chats.filter((c) => c.via === via).length >= MAX_CHATS) return false;
  await TelegramConnection.updateOne(
    { workspaceId },
    { $push: { chats: { ...chat, via, linkedAt: new Date() } }, $setOnInsert: { workspaceId } },
    { upsert: true }
  );
  return true;
}

export async function setOwnBot(workspaceId: string, token: string): Promise<TelegramStatus> {
  const trimmed = token.trim();
  if (!isBotToken(trimmed)) throw new TelegramError("That does not look like a bot token. It should look like 123456789:AAH…");
  const username = await botUsername(trimmed);
  await TelegramConnection.updateOne(
    { workspaceId },
    {
      $set: { ownBot: { tokenEnc: encryptSecret(trimmed), username } },
      $pull: { chats: { via: "own" } },
      $setOnInsert: { workspaceId },
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

export async function deliveryFor(workspaceId: string): Promise<TelegramDelivery | null> {
  const doc = await loadConnection(workspaceId);
  const mode = modeOf(doc);
  const token = mode === "own" ? ownToken(doc) : platformBotToken();
  if (!token) return null;
  return { token, chats: (doc?.chats ?? []).filter((c) => c.via === mode) };
}

type IncomingMessage = { text?: string; chat?: Parameters<typeof toChatInfo>[0] };

async function reply(chatId: string, html: string): Promise<void> {
  const token = platformBotToken();
  if (!token) return;
  try {
    await sendTelegram(token, chatId, html);
  } catch {
    return;
  }
}

async function linkChat(code: string, message: Required<IncomingMessage>): Promise<void> {
  const chat = toChatInfo(message.chat);
  const link = await TelegramLink.findOneAndDelete({ code, expiresAt: { $gt: new Date() } }).lean<{ workspaceId: unknown }>();
  if (!link) {
    await reply(chat.chatId, "This link has expired. Open Quantalog → Reports and press <b>Connect Telegram</b> again.");
    return;
  }
  const workspaceId = String(link.workspaceId);
  const [added, workspace] = await Promise.all([
    addChat(workspaceId, chat, "quantalog"),
    Workspace.findById(workspaceId).select("name").lean<{ name?: string }>(),
  ]);
  const name = escapeHtml(workspace?.name ?? "your workspace");
  await reply(
    chat.chatId,
    added
      ? `Connected to <b>${name}</b>. Reports you send to Telegram in Quantalog will arrive here.\n\nSend /stop at any time to stop them.`
      : `<b>${name}</b> already has ${MAX_CHATS} Telegram chats linked. Remove one in Quantalog, then try again.`
  );
}

async function unlinkChat(chatId: string): Promise<void> {
  await TelegramConnection.updateMany(
    { "chats.chatId": chatId },
    { $pull: { chats: { chatId, via: "quantalog" } } }
  );
  await reply(chatId, "Stopped. Quantalog will not send reports to this chat any more.");
}

export async function handleUpdate(update: {
  message?: IncomingMessage;
  channel_post?: IncomingMessage;
}): Promise<void> {
  const message = update.message ?? update.channel_post;
  const text = message?.text?.trim();
  if (!message?.chat || !text) return;

  const start = START_RE.exec(text);
  if (start) return linkChat(start[1], { text, chat: message.chat });
  if (STOP_RE.test(text)) return unlinkChat(String(message.chat.id));
  if (BARE_START_RE.test(text)) {
    await reply(
      String(message.chat.id),
      "Hi! To get reports here, open Quantalog → Reports, turn on Telegram and press <b>Connect Telegram</b>."
    );
  }
}
