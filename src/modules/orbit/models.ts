/**
 * The models Orbit can answer with, and the order it falls back through.
 *
 * Two providers. Gemini is called directly; the rest go through OpenRouter,
 * which is one key and one request shape for models from four vendors. Adding a
 * model is a line here — nothing else in the stack needs to know the list.
 *
 * Why a chain at all: three of these are free tiers, and a free tier is
 * rate-limited by definition. A support assistant that answers "try again
 * later" the first time two people ask at once is not support. When one model
 * refuses, the next one answers and the user never learns there was a problem.
 */

import { type OrbitTier } from "./types.js";

export type ModelProvider = "gemini" | "openrouter" | "nvidia";

export type OrbitModel = {
  /** Stable id, sent by the client and stored nowhere else. */
  id: string;
  /** Shown in the picker. */
  label: string;
  /**
   * What it is good for, in one line.
   *
   * Kept to roughly thirty characters because it renders on a single row in a
   * narrow menu — anything longer wraps to two lines and turns a scannable
   * list into a wall of text.
   */
  hint: string;
  provider: ModelProvider;
  /** The provider's own model name. */
  model: string;
  /**
   * Whether the model honours a JSON schema.
   *
   * The ones that do not still return JSON — they wrap it in a ``` fence, which
   * the parser strips. This flag only decides whether we bother sending the
   * schema, since some providers reject a request carrying one they cannot
   * satisfy.
   */
  structured: boolean;
  /**
   * What this model would cost to reach, kept as a label rather than a gate.
   *
   * Models are not sold per plan: quota is. Nothing filters on this today —
   * see `availableModels` — and it stays only so a future pricing change has
   * the information it would need.
   */
  tier: OrbitTier;
  /**
   * Whether the model thinks before it writes, spending the token budget on a
   * `reasoning` field first.
   *
   * The answer's own allowance is whatever is left, so at the shared limit
   * these return an empty completion — a 200 with nothing in it, which costs
   * the model its turn in the chain for no reason. Callers give them a larger
   * budget. Measured, not assumed: GPT-OSS answered a short prompt in three
   * seconds and returned an empty string on a long one at the same limit.
   */
  reasoning?: boolean;
};

/**
 * Ordered. The first entry is the default, and a failed call falls through to
 * the next — so this is a preference list, not a menu.
 *
 * Gemini leads because it is the only one on a paid key here: it is the least
 * likely to be rate-limited, and the only one that reliably honours the JSON
 * schema rather than fencing its output.
 */
export const ORBIT_MODELS: OrbitModel[] = [
  {
    id: "gemini-flash",
    label: "Gemini Flash",
    hint: "Fast and accurate. Default.",
    provider: "gemini",
    model: process.env.GEMINI_MODEL || "gemini-flash-latest",
    structured: true,
    tier: "advanced",
  },
  {
    id: "gemma",
    label: "Gemma 4",
    hint: "Open weights, precise.",
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    structured: true,
    // Basic tier's only structured model, which is why it leads the free
    // endpoints: without it, Orbit Free would rely entirely on fence-stripping.
    tier: "basic",
  },
  {
    id: "nemotron",
    label: "Nemotron Ultra",
    hint: "Large model, reasons carefully.",
    provider: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    structured: true,
    reasoning: true,
    tier: "standard",
  },
  {
    id: "deepseek",
    label: "DeepSeek V4",
    hint: "Best for multi-step questions.",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    structured: false,
    reasoning: true,
    tier: "standard",
  },
  {
    id: "gpt-oss",
    label: "GPT-OSS 20B",
    hint: "OpenAI's open model.",
    provider: "openrouter",
    model: "openai/gpt-oss-20b:free",
    structured: false,
    reasoning: true,
    tier: "standard",
  },
  {
    id: "north-mini",
    label: "North Mini",
    hint: "Compact, strong on detail.",
    provider: "openrouter",
    model: "cohere/north-mini-code:free",
    structured: false,
    tier: "standard",
  },
];

/** Whether a provider has the key it needs. */
export function providerReady(provider: ModelProvider): boolean {
  switch (provider) {
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    case "nvidia":
      return Boolean(process.env.NVIDIA_API_KEY);
    default:
      return Boolean(process.env.OPENROUTER_API_KEY);
  }
}

/**
 * The models that can actually run right now, in preference order.
 *
 * Every configured model, for every caller. Models are not sold separately —
 * what a plan buys is quota, history and data access, and a question that has
 * quota may be answered by whichever model is up. The `tier` argument is kept
 * so call sites read the same, and deliberately ignored: gating the list by
 * tier is what left a plan with one eligible model and no fallback when that
 * model was rate-limited.
 */
export function availableModels(_tier?: OrbitTier): OrbitModel[] {
  return ORBIT_MODELS.filter((m) => providerReady(m.provider));
}

/**
 * Resolve the client's choice to a real model within the plan's tier.
 *
 * An unknown, unconfigured, or out-of-tier id falls back to the best model the
 * plan *can* reach rather than failing: the id comes from a browser, and a stale
 * one — a model retired between page load and question, or one left selected
 * when a plan lapsed — should answer, not error.
 */
export function resolveModel(id?: string, tier?: OrbitTier): OrbitModel | undefined {
  const available = availableModels(tier);
  return available.find((m) => m.id === id) ?? available[0];
}

/**
 * The order to try, starting from the chosen model.
 *
 * The choice goes first, then every other configured model in preference order
 * — so a user who picked one that is rate-limited still gets an answer, and one
 * who expressed no preference gets the best available. The chain is only ever
 * as short as the number of providers with keys.
 */
export function fallbackChain(chosen: OrbitModel, tier?: OrbitTier): OrbitModel[] {
  return [chosen, ...availableModels(tier).filter((m) => m.id !== chosen.id)];
}

/**
 * The caller's model, but only if it honours a JSON schema.
 *
 * For routes that need structured output rather than prose. A model without
 * `structured` is never sent the schema, so it answers with a fence, or with a
 * sentence wrapped around the object, or with the JSON double-encoded — all of
 * which a caller then has to guess at. Returning `undefined` lets
 * `resolveModel` pick the best structured model instead.
 *
 * Not a hard restriction: the fallback chain still reaches every model, so an
 * unstructured one answers when the structured ones are rate-limited. This only
 * decides which goes first.
 */
export function structuredModelId(id?: string): string | undefined {
  if (!id) return undefined;
  const model = availableModels().find((m) => m.id === id);
  return model?.structured ? model.id : undefined;
}
