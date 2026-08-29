import { Router, Request, Response } from "express";
import {
  askOrbit,
  orbitConfigured,
  providerReady,
  nonCloudflareModelIds,
  orbitPublicPromptFor,
  PUBLIC_ORBIT_SUGGESTIONS,
  type OrbitTurn,
  type PageContext,
} from "../../modules/orbit/index.js";
import { relevantKnowledge } from "../../modules/orbit/retrieval.js";

const router = Router();

const WINDOW_MS = 60 * 60 * 1000;

const MAX_PER_IP = 12;

const MAX_TURN_CHARS = 2000;

const MAX_HISTORY_TURNS = 8;

const MAX_QUESTION_CHARS = 600;

/**
 * Cap on the page text the browser may send for a "summarise this" question.
 *
 * A long blog post is a few thousand words; 12k characters is enough to cover
 * one without letting a crafted request push an unbounded prompt through an
 * open endpoint. Truncated rather than rejected — the tail of a post matters
 * less than the top, and a partial summary still answers.
 */
const MAX_PAGE_CHARS = 12_000;

/** Page title / URL caps — a sane title and a URL, nothing more. */
const MAX_PAGE_TITLE_CHARS = 200;
const MAX_PAGE_URL_CHARS = 300;

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

/**
 * The page the visitor says they are reading, if the browser sent it.
 *
 * Every field is a string or the whole thing is dropped, and each is
 * length-capped — this is text from a page that could be anything, arriving at
 * an unauthenticated endpoint. The URL is not fetched or trusted, only quoted
 * back to the model as a label, so it needs no host allowlist; a bad one is
 * cosmetic. Returns undefined when there is nothing usable, and the prompt then
 * omits the section entirely.
 */
function readPageContext(raw: unknown): PageContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  const text = typeof p.text === "string" ? p.text.trim().slice(0, MAX_PAGE_CHARS) : "";
  if (!text) return undefined;
  return {
    text,
    title: (typeof p.title === "string" ? p.title : "").trim().slice(0, MAX_PAGE_TITLE_CHARS),
    url: (typeof p.url === "string" ? p.url : "").trim().slice(0, MAX_PAGE_URL_CHARS),
  };
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
  const page = readPageContext(req.body?.pageContext);
  const knowledge = relevantKnowledge(question);

  const result = await askOrbit(question, {
    history,
    systemPrompt: orbitPublicPromptFor(knowledge, page),
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
