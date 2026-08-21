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

import { ORBIT_SYSTEM_PROMPT, orbitPromptWithData } from "./prompt.js";
import { sanitiseModelAnswer } from "./output.js";
import {
  availableModels,
  fallbackChain,
  resolveModel,
  type OrbitModel,
} from "./models.js";
import type { OrbitEntitlement, OrbitHost } from "./types.js";

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
 *
 * Sized against the *envelope*, not the prose. The reply is capped at 4000
 * characters (`MAX_REPLY_CHARS`), roughly 1000 tokens, and everything else in
 * the response is billed to the same ceiling: the JSON scaffolding, three
 * suggestions, and — because a reply is a JSON string — a backslash for every
 * quote and newline in it, which an answer full of `<script src="…">` produces
 * in quantity. At 1400 a long install answer ran out of tokens mid-string and
 * arrived as an unparseable envelope.
 */
const MAX_TOKENS = 2600;

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

export type AskOptions = {
  /** Oldest-first, excluding the current question. Trimmed to the entitlement. */
  history?: OrbitTurn[];
  /** The asker's preferred model. Tried first; everything else after it. */
  modelId?: string;
  /**
   * The product embedding Orbit. Supplies the entitlement and owns quota.
   *
   * Optional so a host with nothing to bill — a script, a test, an internal
   * tool — can call Orbit without implementing an interface it does not need.
   * Without one, every configured model is eligible and nothing is metered.
   */
  host?: OrbitHost;
  /** Opaque tenant key, passed back to the host unchanged. Required with `host`. */
  tenantId?: string;
  /**
   * Replace the assistant's instructions for this call.
   *
   * For internal jobs that want the model plumbing — the fallback chain, the
   * timeouts, the output sanitising — but are not the in-app assistant. The
   * report digest is one: under the support prompt the model correctly refuses
   * it, because "summarise these figures" is not a Quantalog support question.
   *
   * Never set from a request. The prompt decides what the assistant will and
   * will not do, so a caller-supplied one reaching a route would let anyone
   * replace the rules — including the refusal this exists to work around.
   */
  systemPrompt?: string;
};

/**
 * Ask Orbit a question, with the conversation so far for context.
 *
 * With a host, this is the whole transaction: entitlement, quota check, model
 * call, and the spend on success. Keeping the spend here rather than in the
 * caller is what guarantees the two rules that matter — a question is never
 * charged unless it was answered, and it is never answered without quota — hold
 * for every embedder rather than being re-implemented correctly in each one.
 *
 * The entitlement's tier decides which models may answer, both the chosen one
 * and every fallback, so a tier boundary cannot be crossed by a rate limit.
 */
export async function askOrbit(
  question: string,
  options: AskOptions = {},
): Promise<OrbitResult> {
  const { modelId, host, tenantId } = options;

  const entitlement: OrbitEntitlement | null =
    host && tenantId ? await host.entitlement(tenantId) : null;
  const tier = entitlement?.tier;

  const chosen = resolveModel(modelId, tier);
  if (!chosen) {
    return { ok: false, error: "Orbit is not configured on this server.", status: 503 };
  }

  // Before the model call, which is slow and costs money: finding out
  // afterwards that there was no quota means having paid for an answer nobody
  // was entitled to.
  if (host && tenantId && !(await host.hasQuota(tenantId))) {
    return {
      ok: false,
      status: 402,
      error: entitlement
        ? `You have used all ${entitlement.monthlyQuota} questions included this period. Buy a question pack, or upgrade.`
        : "You are out of questions for this period.",
    };
  }

  const history = (options.history ?? []).slice(
    entitlement ? -entitlement.maxHistoryTurns : undefined,
  );

  // Only entitlements with data access get the tenant's figures appended;
  // everyone else gets the base prompt, whose "you cannot read their data" rule
  // then holds. A failure here degrades to the base prompt rather than failing
  // the question: an answer without the numbers still beats an error.
  let prompt = options.systemPrompt ?? ORBIT_SYSTEM_PROMPT;
  // Only the assistant's own prompt takes the tenant's figures. A caller that
  // brought its own instructions also brought its own data in the question.
  if (!options.systemPrompt && entitlement?.dataAccess && host?.dataSummary && tenantId) {
    try {
      prompt = orbitPromptWithData(await host.dataSummary(tenantId));
    } catch (e) {
      console.error("[orbit] data summary failed:", (e as Error).message);
    }
  }

  let lastStatus = 502;
  const startedAt = Date.now();

  for (const model of fallbackChain(chosen, tier)) {
    const elapsed = Date.now() - startedAt;
    // Stop only when the budget is genuinely spent, rather than when a full
    // timeout would no longer fit inside it.
    //
    // The old guard broke the loop at `TOTAL - TIMEOUT`, which is 40s of a 75s
    // budget — so after one slow model the rest of the chain was skipped
    // entirely and the caller was told nothing could answer, while several
    // models were up and would have answered in a second. Most failures here
    // are fast (a 429 or a 503 comes back immediately); it is only a hang that
    // costs a full timeout, and refusing to try because of that possibility is
    // what turned one overloaded provider into a total outage.
    if (elapsed > TOTAL_BUDGET_MS) {
      console.error("[orbit] out of time budget; giving up on the chain");
      break;
    }

    // Whatever is left, so a late attempt still runs rather than being skipped.
    const raw = await callModel(model, question, history, prompt, TOTAL_BUDGET_MS - elapsed);

    if (raw.ok) {
      const parsed = parseAnswer(raw.text);
      // A model that returned prose instead of the agreed shape has still
      // answered; only an empty reply is worth failing over.
      if (parsed) {
        // Charged only now that an answer exists. A spend that fails is logged
        // and swallowed: the asker has their answer, and turning a bookkeeping
        // error into a failed question would take away the thing they came for
        // over a discrepancy of one.
        if (host && tenantId) {
          try {
            await host.spendQuota(tenantId);
          } catch (e) {
            console.error("[orbit] quota spend failed:", (e as Error).message);
          }
        }
        return { ok: true, ...parsed, model: model.id, modelLabel: model.label };
      }
      // A 200 whose body could not be read as an answer. Logged, or a model
      // that always answers unusably looks identical to one that is down.
      console.error(`[orbit] ${model.id} returned an unusable answer; trying the next model`);
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

/**
 * Dispatch to whichever provider owns this model.
 *
 * OpenRouter and NVIDIA both speak the OpenAI chat-completions shape, so they
 * share one caller and differ only in host, key and headers.
 */
function callModel(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
  prompt: string,
  /** What is left of the overall budget, so a late attempt is capped, not skipped. */
  budgetMs = TIMEOUT_MS,
): Promise<CallResult> {
  const timeout = Math.min(TIMEOUT_MS, Math.max(4_000, budgetMs));
  return model.provider === "gemini"
    ? callGemini(model, question, history, prompt, timeout)
    : callOpenAiCompatible(model, question, history, prompt, timeout);
}

/** Host, key and any provider-specific headers for an OpenAI-shaped API. */
function openAiEndpoint(provider: OrbitModel["provider"]) {
  if (provider === "nvidia") {
    return {
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      key: process.env.NVIDIA_API_KEY,
      keyName: "NVIDIA_API_KEY",
      headers: {} as Record<string, string>,
    };
  }
  return {
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY,
    keyName: "OPENROUTER_API_KEY",
    // OpenRouter attributes usage to these, and they are what appear on the
    // dashboard when working out which app spent a quota.
    headers: {
      "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in",
      "X-Title": "Quantalog Orbit",
    },
  };
}

/**
 * A fetch that cannot hang.
 *
 * Without an explicit abort, a stalled upstream holds the socket until the
 * platform's own timeout — and with a fallback chain behind it, that is the
 * difference between a slow answer and no answer at all.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = TIMEOUT_MS,
): Promise<CallResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

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
  prompt: string,
  timeoutMs: number = TIMEOUT_MS,
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
      systemInstruction: { parts: [{ text: prompt }] },
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
    timeoutMs,
  );

  if (!res.ok) return res;

  try {
    const data = JSON.parse(res.text) as {
      candidates?: {
        finishReason?: string;
        content?: { parts?: { text?: string }[] };
      }[];
    };
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    // An empty candidate usually means the safety filter caught something, or
    // the answer was cut off before any text was produced. Either way the next
    // model in the chain should get a turn.
    if (!text) return { ok: false, status: 502, detail: "empty candidate" };

    // Hitting the token ceiling mid-generation leaves a JSON envelope with no
    // closing quote or brace. It cannot be parsed, so the sanitiser has nothing
    // to unwrap and falls back to rendering the raw source — the user reads
    // `{"reply":"To install…` in the chat. Treat it as a failed call so the
    // chain tries another model rather than showing the wreckage.
    if (candidate?.finishReason === "MAX_TOKENS") {
      return { ok: false, status: 502, detail: "truncated at max tokens" };
    }

    return { ok: true, text };
  } catch {
    return { ok: false, status: 502, detail: "unparseable envelope" };
  }
}

async function callOpenAiCompatible(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
  prompt: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<CallResult> {
  const { url, key, keyName, headers } = openAiEndpoint(model.provider);
  if (!key) return { ok: false, status: 503, detail: `no ${keyName}` };

  const res = await post(
    url,
    { Authorization: `Bearer ${key}`, ...headers },
    {
      model: model.model,
      messages: [
        { role: "system", content: prompt },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: question },
      ],
      temperature: 0.3,
      // A reasoning model spends this budget on thinking before it writes
      // anything, so the answer's own allowance is whatever is left. At the
      // shared limit Nemotron routinely ran out mid-thought and returned an
      // empty completion, which cost us the model on every call.
      max_tokens: model.provider === "nvidia" ? MAX_TOKENS * 4 : MAX_TOKENS,
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
    timeoutMs,
  );

  if (!res.ok) return res;

  try {
    const data = JSON.parse(res.text) as {
      choices?: { message?: { content?: string } }[];
      // OpenRouter's error shape, and NVIDIA's, which differ.
      error?: { message?: string };
      detail?: unknown;
    };
    // Both can return 200 with an error body when the upstream provider is the
    // thing that refused.
    if (data.error) return { ok: false, status: 502, detail: data.error.message ?? "upstream error" };
    if (data.detail && !data.choices) {
      return { ok: false, status: 502, detail: JSON.stringify(data.detail).slice(0, 200) };
    }

    // `reasoning_content` is deliberately ignored: on a reasoning model it
    // holds the chain of thought, which is not the answer and should never
    // reach a support conversation.
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
