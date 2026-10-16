import { TelegramConnection } from "./models/TelegramConnection.js";
import { TelegramLink } from "./models/TelegramLink.js";
import { MAX_CHATS, addChat } from "./telegram.service.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { escapeHtml, platformBotToken, sendTelegram, toChatInfo } from "../../infra/messaging/telegram.js";

const START_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;
const STOP_RE = /^\/stop(?:@\w+)?\s*$/;
const BARE_START_RE = /^\/start(?:@\w+)?\s*$/;
const WHERE = "Quantalog → Settings → Connections → Telegram";

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
    await reply(chat.chatId, `This link has expired. Open ${WHERE} and press <b>Connect my chat</b> again.`);
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
      ? `Connected to <b>${name}</b>. Reports and form alerts routed to this chat in Quantalog will arrive here.\n\nSend /stop at any time to stop them.`
      : `<b>${name}</b> already has ${MAX_CHATS} Telegram chats linked. Remove one in Quantalog, then try again.`
  );
}

async function unlinkChat(chatId: string): Promise<void> {
  await TelegramConnection.updateMany(
    { chats: { $elemMatch: { chatId, via: "quantalog" } } },
    { $pull: { chats: { chatId, via: "quantalog" } } }
  );
  await reply(chatId, "Stopped. Quantalog will not send reports or form alerts to this chat any more.");
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
      `Hi! To get reports and form alerts here, open ${WHERE} and press <b>Connect my chat</b>.`
    );
  }
}
