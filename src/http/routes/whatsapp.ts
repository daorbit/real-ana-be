import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { rateLimit } from "../../infra/http-client/safe-fetch.js";
import {
  WhatsAppError,
  removeNumber,
  sendWhatsAppTest,
  setNumberFormAlerts,
  setWhatsAppEnabled,
  whatsappStatus,
} from "../../modules/whatsapp/whatsapp.service.js";
import { confirmVerification, startVerification } from "../../modules/whatsapp/whatsapp-verify.service.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

async function sender(req: AuthedRequest, res: Response) {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return null;
  const allowance = rateLimit(`whatsapp:${ws.id}`, { capacity: 8, refillPerMinute: 3 });
  if (!allowance.allowed) {
    res.status(429).json({ error: `too many WhatsApp messages — try again in ${Math.ceil(allowance.retryAfterMs / 1000)}s` });
    return null;
  }
  return ws;
}

async function respond(res: Response, work: () => Promise<unknown>) {
  try {
    res.json(await work());
  } catch (e) {
    if (e instanceof WhatsAppError) return res.status(400).json({ error: e.message });
    throw e;
  }
}

router.get("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res);
  if (!ws) return;
  res.json(await whatsappStatus(ws.id));
});

router.put("/", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "admin");
  if (!ws) return;
  await respond(res, () => setWhatsAppEnabled(ws.id, Boolean(req.body?.enabled)));
});

router.post("/numbers", async (req: AuthedRequest, res: Response) => {
  const ws = await sender(req, res);
  if (!ws) return;
  await respond(res, () => startVerification(ws.id, String(req.body?.phone ?? ""), String(req.body?.label ?? "")));
});

router.post("/numbers/verify", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;
  await respond(res, () => confirmVerification(ws.id, String(req.body?.phone ?? ""), String(req.body?.code ?? "")));
});

router.patch("/numbers/:phone", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;
  await respond(res, () => setNumberFormAlerts(ws.id, String(req.params.phone), Boolean(req.body?.formAlerts)));
});

router.delete("/numbers/:phone", async (req: AuthedRequest, res: Response) => {
  const ws = await requireWorkspace(req, res, "editor");
  if (!ws) return;
  await respond(res, () => removeNumber(ws.id, String(req.params.phone)));
});

router.post("/test", async (req: AuthedRequest, res: Response) => {
  const ws = await sender(req, res);
  if (!ws) return;
  await respond(res, () => sendWhatsAppTest(ws.id));
});

export default router;
