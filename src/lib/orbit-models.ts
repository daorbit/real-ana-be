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

export type ModelProvider = "gemini" | "openrouter";

export type OrbitModel = {
  /** Stable id, sent by the client and stored nowhere else. */
  id: string;
  /** Shown in the picker. */
  label: string;
  /** One line on what it is good for, so the choice is informed. */
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
    hint: "Fast and accurate. The default.",
    provider: "gemini",
    model: process.env.GEMINI_MODEL || "gemini-flash-latest",
    structured: true,
  },
  {
    id: "gemma",
    label: "Gemma 4",
    hint: "Open weights, strong at following instructions.",
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    structured: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek V4",
    hint: "Reasons through longer, multi-step questions.",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    structured: false,
  },
  {
    id: "gpt-oss",
    label: "GPT-OSS 20B",
    hint: "OpenAI's open model.",
    provider: "openrouter",
    model: "openai/gpt-oss-20b:free",
    structured: false,
  },
  {
    id: "north-mini",
    label: "North Mini",
    hint: "Cohere's compact model. Good on technical detail.",
    provider: "openrouter",
    model: "cohere/north-mini-code:free",
    structured: false,
  },
];

/** Whether a provider has the key it needs. */
export function providerReady(provider: ModelProvider): boolean {
  return provider === "gemini"
    ? Boolean(process.env.GEMINI_API_KEY)
    : Boolean(process.env.OPENROUTER_API_KEY);
}

/** The models that can actually run right now, in preference order. */
export function availableModels(): OrbitModel[] {
  return ORBIT_MODELS.filter((m) => providerReady(m.provider));
}

/**
 * Resolve the client's choice to a real model.
 *
 * An unknown or unconfigured id falls back to the first available rather than
 * failing: the id comes from a browser, and a stale one — a model retired
 * between page load and question — should answer, not error.
 */
export function resolveModel(id?: string): OrbitModel | undefined {
  const available = availableModels();
  return available.find((m) => m.id === id) ?? available[0];
}

/**
 * The order to try, starting from the chosen model.
 *
 * The choice goes first, then everything else in preference order — so a user
 * who picked a model that is rate-limited still gets an answer, and one who
 * expressed no preference gets the best available.
 */
export function fallbackChain(chosen: OrbitModel): OrbitModel[] {
  return [chosen, ...availableModels().filter((m) => m.id !== chosen.id)];
}
