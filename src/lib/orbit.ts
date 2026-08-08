/**
 * Orbit AI — the model call behind the in-app assistant.
 *
 * Two providers over plain HTTPS, no SDKs: each is one POST with a JSON body,
 * and two dependencies that have to be kept in step with fast-moving APIs is a
 * poor trade for the forty lines they would save.
 *
 * Keys are read from the environment on every call rather than captured at
 * import. That keeps a rotated key working after a restart without a rebuild,
 * and it means a missing key is a runtime "not configured" the route can report
 * instead of a crash at boot.
 *
 * The important behaviour here is the fallback. Most of these models are free
 * tiers, which are rate-limited by definition, so a single-model assistant
 * answers "try again later" the moment two people ask at once. When a call
 * fails, the next model in the chain answers and the user never learns there
 * was a problem.
 */

import { ORBIT_SYSTEM_PROMPT } from "./orbit-knowledge.js";
import { sanitiseModelAnswer } from "./model-output.js";
import {
  availableModels,
  fallbackChain,
  resolveModel,
  type OrbitModel,
} from "./orbit-models.js";

/**
 * How long to wait on one model before moving to the next.
 *
 * Tuned against the free tiers, which queue: measured cold, several of them
 * take well over twenty seconds to return a first token, and cutting them off
 * there meant the chain fell through to a paid model on almost every request —
 * defeating the point of having them.
 *
 * The trade is a slow worst case. It is bounded by `TOTAL_BUDGET_MS` below, so
 * a user waits for a couple of failures rather than all of them.
 */
const TIMEOUT_MS = 35_000;

/**
 * The longest anyone waits, across every attempt.
 *
 * Without this, a chain of five models each timing out is nearly three minutes
 * of spinner. The budget stops the loop once there is no realistic chance of
 * answering in time, and the user gets an error while they still care.
 */
const TOTAL_BUDGET_MS = 75_000;

/**
 * Room for a numbered fix — an SEO answer runs to several steps with a tag to
 * paste in each — plus the follow-ups.
 */
const MAX_TOKENS = 1400;

/** At most this many follow-ups. Three fits the panel; more is a menu. */
const MAX_SUGGESTIONS = 3;

/** One turn of the conversation. */
export type OrbitTurn = {
  role: "user" | "assistant";
  content: string;
};

export type OrbitAnswer = {
  reply: string;
  suggestions: string[];
  /** Which model answered. The client shows it, so a fallback is visible. */
  model: string;
  modelLabel: string;
};

export type OrbitResult =
  | ({ ok: true } & OrbitAnswer)
  | { ok: false; error: string; status: number };

/** Whether any provider is configured. Routes check this before accepting a question. */
export function orbitConfigured(): boolean {
  return availableModels().length > 0;
}

/**
 * The JSON shape both providers are asked for.
 *
 * `suggestions` is required rather than optional so a model cannot quietly drop
 * it — an empty array is a decision, a missing key is an oversight.
 */
const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["reply", "suggestions"],
  additionalProperties: false,
} as const;

/**
 * Ask Orbit a question, with the conversation so far for context.
 *
 * `history` is oldest-first and excludes the current question, which is passed
 * separately — the caller should not have to remember to append it in the right
 * shape.
 *
 * `modelId` is the user's preference. It is tried first; everything else is
 * tried after it.
 */
export async function askOrbit(
  question: string,
  history: OrbitTurn[] = [],
  modelId?: string,
): Promise<OrbitResult> {
  const chosen = resolveModel(modelId);
  if (!chosen) {
    return { ok: false, error: "Orbit is not configured on this server.", status: 503 };
  }

  let lastStatus = 502;
  const startedAt = Date.now();

  for (const model of fallbackChain(chosen)) {
    // Stop before starting an attempt that cannot finish inside the budget —
    // beginning a 35s call with 5s left only makes the user wait longer for the
    // same error.
    if (Date.now() - startedAt > TOTAL_BUDGET_MS - TIMEOUT_MS) {
      console.error("[orbit] out of time budget; giving up on the chain");
      break;
    }

    const raw = await callModel(model, question, history);

    if (raw.ok) {
      const parsed = parseAnswer(raw.text);
      // A model that returned prose instead of the agreed shape has still
      // answered; only an empty reply is worth failing over.
      if (parsed) return { ok: true, ...parsed, model: model.id, modelLabel: model.label };
    } else {
      lastStatus = raw.status;
      // Logged per model so a chain that always falls through is visible in the
      // logs rather than only as a slow first answer.
      console.error(`[orbit] ${model.id} failed (${raw.status}): ${raw.detail.slice(0, 300)}`);
    }
  }

  // Everything refused. 429 is the one worth reporting honestly — it is
  // temporary, and whether to wait or give up depends on knowing that.
  return lastStatus === 429
    ? { ok: false, error: "Orbit is busy right now. Try again in a moment.", status: 429 }
    : {
        ok: false,
        error: "Orbit could not answer that. Try again, or use Help & support.",
        status: 502,
      };
}

type CallResult =
  | { ok: true; text: string }
  | { ok: false; status: number; detail: string };

/** Dispatch to whichever provider owns this model. */
function callModel(model: OrbitModel, question: string, history: OrbitTurn[]): Promise<CallResult> {
  return model.provider === "gemini"
    ? callGemini(model, question, history)
    : callOpenRouter(model, question, history);
}

/**
 * A fetch that cannot hang.
 *
 * Without an explicit abort, a stalled upstream holds the socket until the
 * platform's own timeout — and with a fallback chain behind it, that is the
 * difference between a slow answer and no answer at all.
 */
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<CallResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    const text = await res.text();
    // The body is returned to the caller for logging only — it can carry quota
    // details and key fragments, so it never reaches the client.
    return res.ok ? { ok: true, text } : { ok: false, status: res.status, detail: text };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      detail: e instanceof Error ? e.message : "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
): Promise<CallResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, status: 503, detail: "no GEMINI_API_KEY" };

  // Gemini calls the assistant role "model", and takes the system instruction
  // as its own top-level field rather than as a first turn.
  const contents = [...history, { role: "user" as const, content: question }].map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent`,
    { "X-goog-api-key": key },
    {
      systemInstruction: { parts: [{ text: ORBIT_SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        // Low, not zero. Support answers should be stable and factual; zero
        // makes a model repeat an unhelpful phrasing verbatim when a user
        // rewords the same question.
        temperature: 0.3,
        maxOutputTokens: MAX_TOKENS,
        responseMimeType: "application/json",
        // Gemini wants its own uppercase type names rather than JSON Schema's.
        responseSchema: {
          type: "OBJECT",
          properties: {
            reply: { type: "STRING" },
            suggestions: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["reply", "suggestions"],
        },
      },
    },
  );

  if (!res.ok) return res;

  try {
    const data = JSON.parse(res.text) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    // An empty candidate usually means the safety filter caught something, or
    // the answer was cut off before any text was produced. Either way the next
    // model in the chain should get a turn.
    return text ? { ok: true, text } : { ok: false, status: 502, detail: "empty candidate" };
  } catch {
    return { ok: false, status: 502, detail: "unparseable envelope" };
  }
}

async function callOpenRouter(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
): Promise<CallResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, status: 503, detail: "no OPENROUTER_API_KEY" };

  const res = await post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      Authorization: `Bearer ${key}`,
      // OpenRouter attributes usage to these, and they are what appear on the
      // dashboard when working out which app spent a quota.
      "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in",
      "X-Title": "Quantalog Orbit",
    },
    {
      model: model.model,
      messages: [
        { role: "system", content: ORBIT_SYSTEM_PROMPT },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: question },
      ],
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
      // Only sent to models that honour it. Some providers reject a request
      // carrying a schema they cannot satisfy, which would cost us the model
      // entirely rather than just its formatting.
      ...(model.structured
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "orbit_answer", strict: true, schema: SCHEMA },
            },
          }
        : {}),
    },
  );

  if (!res.ok) return res;

  try {
    const data = JSON.parse(res.text) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    // OpenRouter can return 200 with an error body when the upstream provider
    // is the thing that refused.
    if (data.error) return { ok: false, status: 502, detail: data.error.message ?? "upstream error" };

    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? { ok: true, text } : { ok: false, status: 502, detail: "empty completion" };
  } catch {
    return { ok: false, status: 502, detail: "unparseable envelope" };
  }
}

/**
 * Reduce whatever this model returned to an answer.
 *
 * The work happens in `model-output`, which handles the several dialects five
 * models produce for one agreed shape — including the double-encoded envelope
 * that put raw JSON in front of users.
 */
function parseAnswer(raw: string) {
  return sanitiseModelAnswer(raw, { maxSuggestions: MAX_SUGGESTIONS });
}
