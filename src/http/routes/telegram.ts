import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { rateLimit } from "../../infra/http-client/safe-fetch.js";
import {
  TelegramError,
  addOwnChat,
  createLinkUrl,
  findOwnChats,
  removeChat,
  removeOwnBot,
  sendTestMessage,
  setFormAlerts,
  setOwnBot,
  telegramStatus,
} from "../../modules/telegram/telegram.service.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

function budget(workspaceId: string) {
  return rateLimit(`telegram:${workspaceId}`, { capacity: 15, refillPerMinute: 6 });
}

async function editor(req: AuthedRequest, res: Response) {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return null;
  const allowance = budget(ws.id);
  if (!allowance.allowed) {
    res.status(429).json({ error: `too many Telegram requests — try again in ${Math.ceil(allowance.retryAfterMs / 1000)}s` });
    return null;
  }
  return ws;
}

async function respond(res: Response, work: () => Promise<unknown>) {
  try {
    res.json(await work());
  } catch (e) {
    if (e instanceof TelegramError) return res.status(400).json({ error: e.message });
    throw e;
  }
}

router.get("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;
  res.json(await telegramStatus(ws.id));
});

router.post("/link", async (req: AuthedRequest, res: Response) => {
  const ws = await editor(req, res);
  if (!ws) return;
  await respond(res, () => createLinkUrl(ws.id, Boolean(req.body?.group)));
});

router.put("/own-bot", async (req: AuthedRequest, res: Response) => {
  const ws = await editor(req, res);
  if (!ws) return;
  await respond(res, () => setOwnBot(ws.id, String(req.body?.token ?? "")));
});

router.delete("/own-bot", async (req: AuthedRequest, res: Response) => {
  const ws = await editor(req, res);
  if (!ws) return;
  await respond(res, () => removeOwnBot(ws.id));
});

router.get("/own-bot/chats", async (req: AuthedRequest, res: Response) => {
  const ws = await editor(req, res);
  if (!ws) return;
  await respond(res, async () => ({ chats: await findOwnChats(ws.id) }));
});

router.post("/chats", async (req: AuthedRequest, res: Response) => {
  const ws = await editor(req, res);
  if (!ws) return;
  const chatId = String(req.body?.chatId ?? "").trim();
  if (!/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chatId)) {
    return res.status(400).json({ error: "enter a chat ID like 123456789, -1001234567890 or @channelname" });
  }
  await respond(res, () => addOwnChat(ws.id, chatId));
});

router.delete("/chats/:chatId", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;
  await respond(res, () => removeChat(ws.id, String(req.params.chatId)));
});

router.patch("/chats/:chatId", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;
  await respond(res, () => setFormAlerts(ws.id, String(req.params.chatId), Boolean(req.body?.formAlerts)));
});

router.post("/test", async (req: AuthedRequest, res: Response) => {
  const ws = await editor(req, res);
  if (!ws) return;
  await respond(res, () => sendTestMessage(ws.id));
});

export default router;
