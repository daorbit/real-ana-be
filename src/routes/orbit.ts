import { Router, Response } from "express";
import { requireAuth, AuthedRequest } from "../auth.js";
import { askOrbit, orbitConfigured, type OrbitTurn } from "../lib/orbit.js";

/**
 * Orbit AI — the in-app support assistant.
 *
 * Authenticated only. The assistant answers from a product reference rather
 * than from anything account-specific, but a model call costs money on every
 * request, and an open endpoint is a bill someone else gets to run up.
 *
 * Nothing is stored. The conversation lives in the browser and is posted back
 * with each question, which keeps the server stateless and means there is no
 * transcript to retain, expire, or hand over. If reviewing what people actually
 * ask becomes worth having — it is the best docs backlog there is — that is a
 * deliberate addition with a retention policy, not a side effect of chatting.
 */
const router = Router();
router.use(requireAuth);

/** Questions one account may ask per window before being asked to slow down. */
const RATE_LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

/** How much conversation to carry. Older turns are dropped, oldest first. */
const MAX_HISTORY_TURNS = 12;

const MAX_QUESTION_CHARS = 2000;
/** Per past turn. Long enough for a real answer, short enough to bound the prompt. */
const MAX_TURN_CHARS = 4000;

/**
 * In-process request counts, keyed by account.
 *
 * Deliberately not in Mongo: this is throttling, not accounting. Losing the
 * counts on restart costs one user a few extra questions, which is cheaper than
 * a database round trip on every message — and the backstop that actually
 * matters is the quota on the API key itself.
 */
const hits = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);

  // Without this the map grows one entry per user forever. Cheap to do here,
  // and only when someone is actually talking.
  if (hits.size > 500) {
    for (const [id, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(id);
    }
  }

  return recent.length > RATE_LIMIT;
}

/**
 * Take only what we recognise from the client's history.
 *
 * The transcript is supplied by the browser, so it is user input like anything
 * else: every turn is length-capped and anything with an unknown role is
 * dropped rather than passed through to the model.
 */
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
    // Keep the most recent turns: the end of a conversation is what the next
    // question refers to.
    .slice(-MAX_HISTORY_TURNS);
}

/** Whether the assistant is available, so the UI can say so before being opened. */
router.get("/status", (_req: AuthedRequest, res: Response) => {
  res.json({ configured: orbitConfigured() });
});

router.post("/ask", async (req: AuthedRequest, res: Response) => {
  if (!orbitConfigured()) {
    return res.status(503).json({ error: "Orbit is not available on this server." });
  }

  const userId = req.userId ?? "";
  if (rateLimited(userId)) {
    return res.status(429).json({
      error: "That is a lot of questions in one hour. Try again later, or use Email support.",
    });
  }

  const question = String(req.body?.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) {
    return res.status(400).json({ error: "Ask a question first." });
  }

  const result = await askOrbit(question, readHistory(req.body?.history));

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.json({ reply: result.reply, suggestions: result.suggestions });
});

export default router;
