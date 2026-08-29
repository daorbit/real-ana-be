import { Router, Request, Response } from "express";
import {
  askOrbit,
  orbitConfigured,
  providerReady,
  nonCloudflareModelIds,
  orbitPublicPromptFor,
  PUBLIC_ORBIT_SUGGESTIONS,
  type OrbitTurn,
} from "../../modules/orbit/index.js";
import { relevantKnowledge } from "../../modules/orbit/retrieval.js";

const router = Router();

const WINDOW_MS = 60 * 60 * 1000;

const MAX_PER_IP = 12;

const MAX_TURN_CHARS = 2000;

const MAX_HISTORY_TURNS = 8;

const MAX_QUESTION_CHARS = 600;

const PUBLIC_BUDGET_MS = 20_000;
const PUBLIC_ATTEMPT_MS = 12_000;

const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 2000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }

  return recent.length > MAX_PER_IP;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]!.trim();
  return req.ip ?? "unknown";
}

function readHistory(raw: unknown): OrbitTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is { role: string; content: string } =>
        Boolean(t) &&
        typeof t === "object" &&
        typeof (t as { content?: unknown }).content === "string" &&
        ((t as { role?: unknown }).role === "user" ||
          (t as { role?: unknown }).role === "assistant"),
    )
    .map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content.slice(0, MAX_TURN_CHARS),
    }))
    .slice(-MAX_HISTORY_TURNS);
}

function publicOrbitReady(): boolean {
  return orbitConfigured() && providerReady("cloudflare");
}

router.get("/status", (_req: Request, res: Response) => {
  res.json({
    available: publicOrbitReady(),
    suggestions: PUBLIC_ORBIT_SUGGESTIONS,
  });
});

router.post("/ask", async (req: Request, res: Response) => {
  if (!publicOrbitReady()) {
    return res
      .status(503)
      .json({
        error:
          "The assistant is not available right now. Email daorbit2k25@gmail.com.",
      });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({
      error:
        "That is a lot of questions. For anything more, email daorbit2k25@gmail.com — a person will answer.",
    });
  }

  const question = String(req.body?.question ?? "")
    .trim()
    .slice(0, MAX_QUESTION_CHARS);
  if (!question) {
    return res.status(400).json({ error: "Ask a question first." });
  }

  const history = readHistory(req.body?.history);
  const knowledge = relevantKnowledge(question);

  const result = await askOrbit(question, {
    history,
    systemPrompt: orbitPublicPromptFor(knowledge),
    // Cloudflare only: everything else is barred, so the chain is the two
    // Llama models and nothing that carries a per-token bill.
    exclude: nonCloudflareModelIds(),
    budgetMs: PUBLIC_BUDGET_MS,
    attemptMs: PUBLIC_ATTEMPT_MS,
    // No host: nothing to meter, and every eligible (Cloudflare) model is
    // allowed.
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.json({
    reply: result.reply,
    suggestions: result.suggestions,
  });
});

export default router;
