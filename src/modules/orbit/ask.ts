
import { orbitPromptFor, orbitPromptWithData } from "./prompt.js";
import { docIndex, relevantKnowledge, selectedHeadings } from "./retrieval.js";
import { cloudflareChat, cloudflareVisionChat, cloudflareGenerateImage } from "./cloudflare-ai.js";
import { sanitiseModelAnswer } from "./output.js";
import {
  availableModels,
  fallbackChain,
  resolveModel,
  type OrbitModel,
} from "./models.js";
import type { OrbitEntitlement, OrbitHost } from "./types.js";


const TIMEOUT_MS = 35_000;

const TOTAL_BUDGET_MS = 75_000;

const MIN_ATTEMPT_MS = 4_000;


const ABANDONED: OrbitResult = {
  ok: false,
  status: 499,
  error: "Stopped before an answer arrived.",
};



const MAX_TOKENS = 4000;

/** At most this many follow-ups. Three fits the panel; more is a menu. */
const MAX_SUGGESTIONS = 3;


const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Room for a description of an image plus a few follow-up sentences. */
const VISION_MAX_TOKENS = 1024;


const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** The default step count. Higher looks better and costs more of the shared
 * daily neuron budget; four is FLUX Schnell's own recommended default. */
const IMAGE_STEPS = 4;


/**
 * Words that only mean something on top of an actual metric — "my traffic" is
 * a data question, but "my email address" or "update my password" is not, so
 * a bare pronoun can never trigger the digest on its own.
 */
const POSSESSIVE_MARKERS = ["my", "our", "mine", "we", "us"];

/** Words that mean the question is about the tenant's own figures on their
 * own, no pronoun needed. */
const TOPIC_MARKERS = [
  "yesterday", "today", "this week", "last week", "this month", "last month",
  "traffic", "visitors", "pageviews", "sessions", "bounce rate",
  "how many visitors", "how many pageviews", "how much traffic",
  "top pages", "top referrers", "top countries",
  "competitor", "beat them", "beat our competitor",
  "performing", "performance",
];

/** A comparison/ranking word that only reads as a data question paired with a
 * possessive pronoun — "are we up or down", "how did we score" — since alone
 * these are common English words with no connection to analytics at all. */
const COMPARISON_MARKERS = [
  "doing", "up", "down", "dropped", "drop", "fell", "spike", "increase",
  "decrease", "score", "rank", "ranking", "compare", "compared",
];

function wordRe(markers: string[]): RegExp {
  return new RegExp(
    `\\b(?:${markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "i",
  );
}

const POSSESSIVE_RE = wordRe(POSSESSIVE_MARKERS);
const TOPIC_RE = wordRe(TOPIC_MARKERS);
const COMPARISON_RE = wordRe(COMPARISON_MARKERS);


function wantsData(question: string): boolean {
  if (TOPIC_RE.test(question)) return true;
  return POSSESSIVE_RE.test(question) && COMPARISON_RE.test(question);
}

/** Where the stable rules end and this question's own context begins. */
const KNOWLEDGE_MARKER = "\n\nProduct reference:\n\n";


function cacheableSystem(prompt: string, provider: OrbitModel["provider"]): unknown {

  if (provider !== "openrouter") return prompt;

  const at = prompt.indexOf(KNOWLEDGE_MARKER);

  if (at === -1) return prompt;

  return [
    {
      type: "text",
      text: prompt.slice(0, at),
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: prompt.slice(at) },
  ];
}

/** One turn of the conversation. */
export type OrbitTurn = {
  role: "user" | "assistant";
  content: string;
};

export type OrbitAnswer = {
  reply: string;
  suggestions: string[];
  model: string;
  modelLabel: string;
  imageBase64?: string;
  dataDigest?: unknown;
  /** Pages a web search drew on, when the model used one. Only Claude's own
   * search tool populates this today — see callAnthropic. */
  citations?: OrbitCitation[];
};

export type OrbitResult =
  | ({ ok: true } & OrbitAnswer)
  | { ok: false; error: string; status: number; quotaExceeded?: true };

export function orbitConfigured(): boolean {
  return availableModels().length > 0;
}

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
  history?: OrbitTurn[];
  modelId?: string;

  image?: string;

  generateImage?: boolean;
  host?: OrbitHost;
  tenantId?: string;

  systemPrompt?: string;

  exclude?: string[];

  budgetMs?: number;

  attemptMs?: number;

  signal?: AbortSignal;
  rawOutput?: boolean;
};


export async function askOrbit(
  question: string,
  options: AskOptions = {},
): Promise<OrbitResult> {
  // An attached image is answered entirely differently — one model, no
  // chain, no product reference, no history-driven retrieval — so it is
  // handed off before any of the text-path setup below even runs.
  if (options.image) return askOrbitVision(question, options.image, options);
  if (options.generateImage) return askOrbitGenerateImage(question, options);

  const {
    modelId,
    host,
    tenantId,
    exclude = [],
    budgetMs = TOTAL_BUDGET_MS,
    attemptMs = TIMEOUT_MS,
    signal,
    rawOutput = false,
  } = options;
  const barred = new Set(exclude);

  const entitlement: OrbitEntitlement | null =
    host && tenantId ? await host.entitlement(tenantId) : null;
  const tier = entitlement?.tier;

  // The chain, minus anything the caller barred. Resolved before the chosen
  // model so a barred preference falls through to the best allowed one rather
  // than being tried and skipped.
  const eligible = availableModels(tier).filter((m) => !barred.has(m.id));
  if (eligible.length === 0) {
    return { ok: false, error: "Orbit is not configured on this server.", status: 503 };
  }
  const chosen = eligible.find((m) => m.id === modelId) ?? eligible[0];

  // Before the model call, which is slow and costs money: finding out
  // afterwards that there was no quota means having paid for an answer nobody
  // was entitled to.
  if (host && tenantId && !(await host.hasQuota(tenantId))) {
    return {
      ok: false,
      status: 402,
      quotaExceeded: true,
      error: entitlement
        ? `You have used all ${entitlement.monthlyQuota} questions included this period. Buy a question pack, or upgrade.`
        : "You are out of questions for this period.",
    };
  }

  const history = (options.history ?? []).slice(
    entitlement ? -entitlement.maxHistoryTurns : undefined,
  );


  const knowledge = relevantKnowledge(question);
  if (process.env.ORBIT_DEBUG_PROMPT) {
    console.log(
      `[orbit] sections=${selectedHeadings(question).join("|") || "all"} ` +
        `knowledge=${knowledge.length}ch`,
    );
  }

  const pages = docIndex();

  let prompt = options.systemPrompt ?? orbitPromptFor(knowledge, pages);

  let dataDigest: unknown;

  if (
    !options.systemPrompt &&
    entitlement?.dataAccess &&
    host?.dataSummary &&
    tenantId &&
    wantsData(question)
  ) {
    try {
      prompt = orbitPromptWithData(
        await host.dataSummary(tenantId, question),
        knowledge,
        pages,
      );
      // Best-effort and independent of the text digest above: a host may
      // implement one without the other, and a failure here should not cost
      // the question its prose answer.
      if (host.dataDigest) {
        dataDigest = await host.dataDigest(tenantId, question).catch(() => undefined);
      }
    } catch (e) {
      console.error("[orbit] data summary failed:", (e as Error).message);
    }
  }

  let lastStatus = 502;
  const startedAt = Date.now();

  // The chosen model first, then the rest of what is allowed.
  const chain = [chosen, ...eligible.filter((m) => m.id !== chosen.id)];

  for (const model of chain) {
    const elapsed = Date.now() - startedAt;

    if (elapsed > budgetMs - MIN_ATTEMPT_MS) {
      console.error("[orbit] out of time budget; giving up on the chain");
      break;
    }

    if (signal?.aborted) return ABANDONED;

    // Whatever is left, so a late attempt still runs rather than being skipped.
    const raw = await callModel(
      model,
      question,
      history,
      prompt,
      budgetMs - elapsed,
      attemptMs,
      signal,
    );

    if (signal?.aborted) return ABANDONED;

    if (raw.ok) {
      // `rawOutput` callers asked the model for their own JSON shape, so the
      // envelope check would reject the very thing they asked for.
      const parsed = rawOutput
        ? raw.text.trim()
          ? { reply: raw.text.trim(), suggestions: [] as string[] }
          : null
        : parseAnswer(raw.text);
      // A model that returned prose instead of the agreed shape has still
      // answered; only an empty reply is worth failing over.
      if (parsed) {
        if (host && tenantId) {
          try {
            await host.spendQuota(tenantId);
          } catch (e) {
            console.error("[orbit] quota spend failed:", (e as Error).message);
          }
        }
        return {
          ok: true,
          ...parsed,
          model: model.id,
          modelLabel: model.label,
          dataDigest,
          citations: raw.citations,
        };
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

async function askOrbitVision(
  question: string,
  image: string,
  options: AskOptions,
): Promise<OrbitResult> {
  const { host, tenantId, budgetMs = TOTAL_BUDGET_MS, signal } = options;

  if (host && tenantId && !(await host.hasQuota(tenantId))) {
    const entitlement = await host.entitlement(tenantId);
    return {
      ok: false,
      status: 402,
      quotaExceeded: true,
      error: entitlement
        ? `You have used all ${entitlement.monthlyQuota} questions included this period. Buy a question pack, or upgrade.`
        : "You are out of questions for this period.",
    };
  }

  const comma = image.indexOf(",");
  const base64 = comma === -1 ? image : image.slice(comma + 1);
 
  const VISION_HISTORY_TURNS = 4;
  const VISION_TURN_CHARS = 200;
  const historyTurns = (options.history ?? []).slice(-VISION_HISTORY_TURNS);
  let prompt = question || "Describe what's in this image.";
  if (historyTurns.length > 0) {
    const transcript = historyTurns
      .map((t) => {
        const text = t.content.length > VISION_TURN_CHARS
          ? t.content.slice(0, VISION_TURN_CHARS) + "…"
          : t.content;
        return `${t.role}: ${text}`;
      })
      .join("\n");
    prompt = `Earlier in this conversation:\n${transcript}\n\nQuestion about the image: ${prompt}`;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.min(TIMEOUT_MS, budgetMs));
  const relay = () => abort.abort();
  signal?.addEventListener("abort", relay);
  if (signal?.aborted) abort.abort();

  let raw;
  try {
    raw = await cloudflareVisionChat({
      model: VISION_MODEL,
      image: base64,
      prompt,
      maxTokens: VISION_MAX_TOKENS,
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }

  // Before the spend below, so a question nobody waited for is not charged.
  if (signal?.aborted) return ABANDONED;

  if (!raw.ok) {
    console.error(`[orbit] vision call failed (${raw.status}): ${raw.detail.slice(0, 300)}`);
    return raw.status === 429
      ? { ok: false, error: "Orbit is busy right now. Try again in a moment.", status: 429 }
      : {
          ok: false,
          error: "Orbit could not read that image. Try again, or use Help & support.",
          status: 502,
        };
  }

  if (host && tenantId) {
    try {
      await host.spendQuota(tenantId);
    } catch (e) {
      console.error("[orbit] quota spend failed:", (e as Error).message);
    }
  }

  return {
    ok: true,
    reply: raw.text.trim(),
    suggestions: [],
    model: "llama-vision",
    modelLabel: "Llama 3.2 Vision",
  };
}


async function askOrbitGenerateImage(
  question: string,
  options: AskOptions,
): Promise<OrbitResult> {
  const { host, tenantId, budgetMs = TOTAL_BUDGET_MS, signal } = options;

  if (!question.trim()) {
    return { ok: false, status: 400, error: "Say what to draw." };
  }

  if (host && tenantId && !(await host.hasQuota(tenantId))) {
    const entitlement = await host.entitlement(tenantId);
    return {
      ok: false,
      status: 402,
      quotaExceeded: true,
      error: entitlement
        ? `You have used all ${entitlement.monthlyQuota} questions included this period. Buy a question pack, or upgrade.`
        : "You are out of questions for this period.",
    };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.min(TIMEOUT_MS, budgetMs));
  const relay = () => abort.abort();
  signal?.addEventListener("abort", relay);
  if (signal?.aborted) abort.abort();

  let raw;
  try {
    raw = await cloudflareGenerateImage({
      model: IMAGE_MODEL,
      prompt: question.trim(),
      steps: IMAGE_STEPS,
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }

  // Before the spend below, so a picture nobody waited for is not charged.
  if (signal?.aborted) return ABANDONED;

  if (!raw.ok) {
    console.error(`[orbit] image generation failed (${raw.status}): ${raw.detail.slice(0, 300)}`);
    return raw.status === 429
      ? { ok: false, error: "Orbit is busy right now. Try again in a moment.", status: 429 }
      : {
          ok: false,
          error: "Orbit could not draw that. Try again, or use Help & support.",
          status: 502,
        };
  }

  if (host && tenantId) {
    try {
      await host.spendQuota(tenantId);
    } catch (e) {
      console.error("[orbit] quota spend failed:", (e as Error).message);
    }
  }

  return {
    ok: true,

    reply: "Here's what I drew.",
    suggestions: [],
    model: "flux-schnell",
    modelLabel: "FLUX",
    imageBase64: raw.image,
  };
}

/** One page a web-search-backed answer drew on, for the client to link. */
export type OrbitCitation = { url: string; title: string };

type CallResult =
  | { ok: true; text: string; citations?: OrbitCitation[] }
  | { ok: false; status: number; detail: string };

function callModel(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
  prompt: string,
  /** What is left of the overall budget, so a late attempt is capped, not skipped. */
  budgetMs = TIMEOUT_MS,
  /** The caller's per-attempt ceiling; the default is the standard timeout. */
  attemptMs = TIMEOUT_MS,
  /** Gives up when this fires, on top of the timeouts. */
  signal?: AbortSignal,
): Promise<CallResult> {
  const timeout = Math.min(attemptMs, Math.max(MIN_ATTEMPT_MS, budgetMs));
  if (model.provider === "gemini") {
    return callGemini(model, question, history, prompt, timeout, signal);
  }
  if (model.provider === "cloudflare") {
    return callCloudflare(model, question, history, prompt, timeout, signal);
  }
  if (model.provider === "anthropic") {
    return callAnthropic(model, question, history, prompt, timeout, signal);
  }
  return callOpenAiCompatible(model, question, history, prompt, timeout, signal);
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

    headers: {
      "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in",
      "X-Title": "Quantalog Orbit",
    },
  };
}


async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = TIMEOUT_MS,
  caller?: AbortSignal,
): Promise<CallResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const relay = () => abort.abort();
  caller?.addEventListener("abort", relay);
  if (caller?.aborted) abort.abort();

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
    caller?.removeEventListener("abort", relay);
  }
}

async function callGemini(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
  prompt: string,
  timeoutMs: number = TIMEOUT_MS,
  signal?: AbortSignal,
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
    signal,
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

    if (!text) return { ok: false, status: 502, detail: "empty candidate" };

    if (candidate?.finishReason === "MAX_TOKENS") {
      return { ok: false, status: 502, detail: "truncated at max tokens" };
    }

    return { ok: true, text };
  } catch {
    return { ok: false, status: 502, detail: "unparseable envelope" };
  }
}


async function callCloudflare(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
  prompt: string,
  timeoutMs: number = TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CallResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const relay = () => abort.abort();
  signal?.addEventListener("abort", relay);
  if (signal?.aborted) abort.abort();

  try {
    return await cloudflareChat({
      model: model.model,
      messages: [
        { role: "system", content: prompt },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: question },
      ],
      maxTokens: model.reasoning ? MAX_TOKENS * 4 : MAX_TOKENS,
      temperature: 0.3,
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/** Defaults to Anthropic's own API; overridable for a compatible proxy. */
function anthropicBaseUrl(): string {
  return (process.env.CLAUDE_API_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
}
const MAX_WEB_SEARCHES = 3;

async function callAnthropic(
  model: OrbitModel,
  question: string,
  history: OrbitTurn[],
  prompt: string,
  timeoutMs: number = TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CallResult> {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) return { ok: false, status: 503, detail: "no CLAUDE_API_KEY" };

  const res = await post(
    `${anthropicBaseUrl()}/v1/messages`,
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    {
      model: model.model,
      system: prompt,
      messages: [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: question },
      ],
      temperature: 0.3,
      max_tokens: model.reasoning ? MAX_TOKENS * 4 : MAX_TOKENS,

      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES }],
    },
    timeoutMs,
    signal,
  );

  if (!res.ok) return res;

  try {
    const data = JSON.parse(res.text) as {
      content?: {
        type?: string;
        text?: string;
        citations?: { url?: string; title?: string }[];
      }[];
      error?: { message?: string };
      stop_reason?: string;
    };

    if (data.error) return { ok: false, status: 502, detail: data.error.message ?? "upstream error" };

    const textBlocks = data.content?.filter((b) => b.type === "text") ?? [];
    const text = textBlocks.map((b) => b.text ?? "").join("").trim();

    const seen = new Set<string>();
    const citations: OrbitCitation[] = [];
    for (const block of textBlocks) {
      for (const c of block.citations ?? []) {
        if (!c.url || seen.has(c.url)) continue;
        seen.add(c.url);
        citations.push({ url: c.url, title: c.title?.trim() || c.url });
      }
    }

    if (!text) return { ok: false, status: 502, detail: "empty completion" };
    return citations.length ? { ok: true, text, citations } : { ok: true, text };
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
  signal?: AbortSignal,
): Promise<CallResult> {
  const { url, key, keyName, headers } = openAiEndpoint(model.provider);
  if (!key) return { ok: false, status: 503, detail: `no ${keyName}` };

  const res = await post(
    url,
    { Authorization: `Bearer ${key}`, ...headers },
    {
      model: model.model,
      messages: [
        // A plain string, except on OpenRouter with a splittable prompt, where
        // the stable rules block is sent as its own cacheable content part.
        { role: "system", content: cacheableSystem(prompt, model.provider) },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user", content: question },
      ],
      temperature: 0.3,

      max_tokens: model.reasoning ? MAX_TOKENS * 4 : MAX_TOKENS,

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
    signal,
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
