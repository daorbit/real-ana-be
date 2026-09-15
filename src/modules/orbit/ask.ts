
import { orbitPromptFor, orbitPromptWithData } from "./prompt.js";
import { relevantKnowledge, selectedHeadings } from "./retrieval.js";
import { cloudflareChat, cloudflareVisionChat, cloudflareGenerateImage } from "./cloudflare-ai.js";
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

const TOTAL_BUDGET_MS = 75_000;

const MIN_ATTEMPT_MS = 4_000;

/**
 * What comes back when the caller gave up before an answer did.
 *
 * 499, borrowed from nginx: the client closed the connection. Not a failure
 * of ours and not the client's error either, so neither a 5xx nor a plain
 * 4xx says it. Nothing is written to the socket in practice — there is no
 * longer a socket — but the route still needs a result to return, and one
 * that is unmistakably *not* an answer is what keeps the spend and the
 * transcript write on the success path only.
 */
const ABANDONED: OrbitResult = {
  ok: false,
  status: 499,
  error: "Stopped before an answer arrived.",
};

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

/**
 * The one model that reads an attached image.
 *
 * Deliberately not in `ORBIT_MODELS` — that catalogue feeds the picker and
 * the model-selection chain, and this model is never picked. It is reached
 * only by `askOrbitVision`, which `askOrbit` defers to the moment a call
 * carries an image, before any of the usual chain/fallback logic runs.
 */
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Room for a description of an image plus a few follow-up sentences. */
const VISION_MAX_TOKENS = 1024;

/**
 * The one model that draws a picture.
 *
 * Same treatment as `VISION_MODEL`: not in `ORBIT_MODELS`, never fallen back
 * to or from, reached only through `askOrbitGenerateImage` when a call is
 * explicitly asking to generate rather than to chat.
 */
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** The default step count. Higher looks better and costs more of the shared
 * daily neuron budget; four is FLUX Schnell's own recommended default. */
const IMAGE_STEPS = 4;

/**
 * Phrases that mean "about my own numbers" rather than "about the product".
 *
 * Building the workspace digest costs several database queries and a large
 * block of prompt, and most support questions cannot use a single figure in it.
 * This decides whether that is worth doing.
 *
 * Written to over-include on purpose. Sending the digest to a question that did
 * not need it wastes tokens; withholding it from one that did produces "I
 * cannot see your analytics" to someone whose plan says otherwise, which is a
 * bug report. So anything possessive, comparative, or time-bound counts, and
 * only a question with none of those markers skips it.
 */
const DATA_MARKERS = [
  " my ", " our ", " mine", " we ", " us ",
  "yesterday", "today", "this week", "last week", "this month", "last month",
  "traffic", "visitors", "pageviews", "views", "sessions", "bounce",
  "how many", "how much", "top ", "best ", "worst ", "most ",
  "down", "up ", "dropped", "drop", "fell", "spike", "increase", "decrease",
  "why is", "why are", "why did", "compare", "competitor", "beat them",
  "score", "rank", "performing", "performance",
];

function wantsData(question: string): boolean {
  const q = ` ${question.toLowerCase()} `;
  return DATA_MARKERS.some((m) => q.includes(m));
}

/** Where the stable rules end and this question's own context begins. */
const KNOWLEDGE_MARKER = "\n\nProduct reference:\n\n";

/**
 * The system prompt split into a cacheable prefix and the rest.
 *
 * Everything up to the product reference is identical on every call, so it is
 * sent as its own content part carrying a cache marker; the reference sections
 * and any workspace figures follow in a second, uncached part. Providers that
 * support prompt caching bill the first at a fraction of fresh input, and
 * providers that do not simply see a two-part message with an unknown field.
 *
 * A prompt with no marker (a caller's own `systemPrompt`) is returned as one
 * uncached part rather than guessed at — splitting someone else's instructions
 * at an arbitrary point is how a cache prefix stops being stable.
 */
function cacheableSystem(prompt: string, provider: OrbitModel["provider"]): unknown {
  // Only OpenRouter documents `cache_control` on a content part. Sending the
  // array form to a provider that has no use for it is all risk and no saving:
  // NVIDIA's endpoint is strict about the system message's shape, and a
  // rejected request costs that model its turn in the chain.
  if (provider !== "openrouter") return prompt;

  const at = prompt.indexOf(KNOWLEDGE_MARKER);
  // A plain string when there is nothing to cache — which is every caller that
  // brought its own instructions, the social scheduler included. Several models
  // reject a content *array* on the system message outright, so wrapping an
  // unsplittable prompt in one to no benefit failed the whole chain and the
  // route answered "Orbit could not answer that" whatever model was picked.
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
  /** Which model answered. The client shows it, so a fallback is visible. */
  model: string;
  modelLabel: string;
  /** A generated picture, base64 with no `data:` prefix — set only when the
   * call asked for one. */
  imageBase64?: string;
};

export type OrbitResult =
  | ({ ok: true } & OrbitAnswer)
  /**
   * `quotaExceeded` marks the one failure the host should surface as an upgrade
   * prompt rather than an error. Named rather than inferred from the 402, so the
   * host does not have to read status codes to tell a spent allowance from any
   * other payment-shaped refusal.
   */
  | { ok: false; error: string; status: number; quotaExceeded?: true };

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
   * A base64 image data URL (`data:image/...;base64,...`) to answer a
   * question about, already size- and type-validated by the route.
   *
   * Its presence, not `modelId`, decides the model: `askOrbit` defers to
   * `askOrbitVision` the moment this is set, before any of the usual
   * chain/fallback/history logic runs. There is exactly one vision model, so
   * there is nothing to pick and nothing to fall back to.
   */
  image?: string;
  /**
   * Draw a picture from `question` instead of answering it.
   *
   * Its own path, ahead of everything else in `askOrbit` — same deal as
   * `image`, a different call entirely rather than a flag threaded through
   * the text chain. Ignored if `image` is also set; a call is read *or*
   * drawn, never both.
   */
  generateImage?: boolean;
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
  /**
   * Models this call must not use, by id.
   *
   * For a caller that knows something the model list cannot express — a route
   * on a request path excluding a provider that is currently unhealthy, or a
   * reasoning model whose thinking time is longer than the caller can wait.
   * The chain is filtered, not reordered, so what remains still falls back
   * normally among itself.
   */
  exclude?: string[];
  /**
   * Cap on the whole call, in milliseconds.
   *
   * Defaults to the standard budget. A route rendering into a chat panel
   * someone is watching wants a much shorter one than a background job does.
   */
  budgetMs?: number;
  /**
   * Cap on a single model attempt, in milliseconds.
   *
   * Separate from `budgetMs` because they bound different things: the budget is
   * how long the *person* waits, this is how long one hung provider may hold
   * that budget hostage. A route with a tight budget needs a tighter attempt
   * ceiling to fit more than one try inside it — at the default 35s, a 70s
   * budget buys two attempts only if both fail at exactly the timeout.
   */
  attemptMs?: number;
  /**
   * Gives up when this fires, wherever the call has got to.
   *
   * For a caller whose reason to stop is outside the timeouts — on a request
   * path, the person closing the tab or pressing stop. Without it the model
   * call runs to completion and is charged for, into a socket nobody is
   * reading: the timeouts protect us from a hung provider, not from an answer
   * no one is waiting for any more.
   *
   * Composed with each attempt's own timeout rather than replacing it. Both
   * still apply — whichever fires first ends the attempt.
   */
  signal?: AbortSignal;
  /**
   * Accept the model's raw text instead of requiring Orbit's answer envelope.
   *
   * For callers that asked for their own JSON shape. The envelope exists for
   * the chat panel, where an answer is prose plus follow-up questions; a route
   * that told the model to return a plan object gets exactly that, and
   * `sanitiseModelAnswer` then rejects it for having no `reply` key — a model
   * that followed the instruction perfectly is scored as having failed.
   *
   * The older models hid this by wrapping their object in `{"reply": "{...}"}`,
   * which is double-encoded JSON and the thing `parsePlan` spends most of its
   * length undoing. Llama returns the object directly, which is what was asked
   * for, so this flag stops punishing it for that.
   *
   * `suggestions` is always empty here: nothing produced them, and inventing
   * them from the raw text would put fragments of a JSON document into the
   * follow-up buttons.
   */
  rawOutput?: boolean;
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

  // Only entitlements with data access get the tenant's figures appended;
  // everyone else gets the base prompt, whose "you cannot read their data" rule
  // then holds. A failure here degrades to the base prompt rather than failing
  // the question: an answer without the numbers still beats an error.
  // Only the sections this question needs, rather than the whole reference.
  // The rules block in front of them is byte-identical every time, which is
  // what the providers' prompt caches key on.
  const knowledge = relevantKnowledge(question);
  if (process.env.ORBIT_DEBUG_PROMPT) {
    console.log(
      `[orbit] sections=${selectedHeadings(question).join("|") || "all"} ` +
        `knowledge=${knowledge.length}ch`,
    );
  }

  let prompt = options.systemPrompt ?? orbitPromptFor(knowledge);
  // Only the assistant's own prompt takes the tenant's figures. A caller that
  // brought its own instructions also brought its own data in the question.
  //
  // The digest is fetched only when the question is actually about their
  // numbers: "how do I install the tracker" was paying to build and send a
  // stats-and-competitor summary it could not use, on the most expensive tier.
  if (
    !options.systemPrompt &&
    entitlement?.dataAccess &&
    host?.dataSummary &&
    tenantId &&
    wantsData(question)
  ) {
    try {
      prompt = orbitPromptWithData(await host.dataSummary(tenantId), knowledge);
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
    //
    // The floor below is not a return to that: it reserves a few seconds, not
    // a full timeout, so the loop stops starting an attempt that provably
    // cannot finish — at 69s of a 70s budget the old check still began a call
    // and let it run past the ceiling the budget exists to enforce.
    if (elapsed > budgetMs - MIN_ATTEMPT_MS) {
      console.error("[orbit] out of time budget; giving up on the chain");
      break;
    }

    // Nobody is waiting for this any more. Checked before each attempt as well
    // as inside the call, because the chain's whole purpose is to try the next
    // model when one fails — and an abort makes every remaining attempt fail
    // instantly, which would walk the entire chain for an answer with no
    // reader.
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

/**
 * The image path. Same quota contract as `askOrbit` — checked before the
 * call, spent only on success — but nothing else about the text path
 * applies: no product reference, no retrieval, no fallback chain (there is
 * one vision model), and no structured `{reply, suggestions}` envelope,
 * since this endpoint does not support `response_format`.
 */
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
      prompt: question || "Describe what's in this image.",
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

/**
 * The image-generation path. Same quota contract as the other two, one call,
 * no fallback — the reply here isn't prose at all, it's the picture itself,
 * carried on `imageBase64` with `reply` left as a short caption.
 */
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

/**
 * Cloudflare Workers AI, through the client in `infra/http-client`.
 *
 * The system prompt is sent as an ordinary first message: this endpoint has no
 * system field of its own, and no cache markers either, so the prompt goes
 * whole rather than split the way the OpenRouter path splits it.
 */
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
      // A reasoning model spends this budget on thinking before it writes
      // anything, so the answer's own allowance is whatever is left. At the
      // shared limit these run out mid-thought and return an empty completion,
      // which costs the model its turn for no reason — Nemotron did it on
      // every call, and GPT-OSS does it on any prompt long enough to reason
      // about. Flagged per model rather than per provider: it is a property of
      // the model, and the provider is the wrong thing to key it on.
      max_tokens: model.reasoning ? MAX_TOKENS * 4 : MAX_TOKENS,
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
