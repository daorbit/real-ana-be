 
import { type OrbitTier } from "./types.js";

export type ModelProvider = "gemini" | "openrouter" | "nvidia" | "cloudflare";

export type OrbitModel = {
  id: string;
  label: string;
 
  hint: string;
  provider: ModelProvider;
  model: string;
 
  structured: boolean;
 
  tier: OrbitTier;
  reasoning?: boolean;
};
 
 
export const ORBIT_MODELS: OrbitModel[] = [
  // {
  //   id: "gemini-flash",
  //   label: "Gemini Flash",
  //   hint: "Fast and accurate. Default.",
  //   provider: "gemini",
  //   model: process.env.GEMINI_MODEL || "gemini-flash-latest",
  //   structured: true,
  //   tier: "advanced",
  // },
  // {
  //   id: "gemma",
  //   label: "Gemma 4",
  //   hint: "Open weights, precise.",
  //   provider: "openrouter",
  //   model: "google/gemma-4-26b-a4b-it:free",
  //   structured: true,
  //   // Basic tier's only structured model, which is why it leads the free
  //   // endpoints: without it, Orbit Free would rely entirely on fence-stripping.
  //   tier: "basic",
  // },
  // {
  //   id: "nemotron",
  //   label: "Nemotron Ultra",
  //   hint: "Large model, reasons carefully.",
  //   provider: "nvidia",
  //   model: "nvidia/nemotron-3-ultra-550b-a55b",
  //   structured: true,
  //   reasoning: true,
  //   tier: "standard",
  // },
  {
    id: "llama-fast",
    label: "Llama 3.3 70B",
    hint: "Fastest for structured replies.",
    provider: "cloudflare",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    structured: false,
    tier: "standard",
  },
  {
    id: "llama-8b",
    label: "Llama 3.1 8B",
    hint: "Quickest, for short replies.",
    provider: "cloudflare",
    model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    structured: false,
    tier: "basic",
  },
  // {
  //   id: "deepseek",
  //   label: "DeepSeek V4",
  //   hint: "Best for multi-step questions.",
  //   provider: "openrouter",
  //   model: "deepseek/deepseek-v4-pro",
  //   structured: false,
  //   reasoning: true,
  //   tier: "standard",
  // },
  // {
  //   id: "gpt-oss",
  //   label: "GPT-OSS 20B",
  //   hint: "OpenAI's open model.",
  //   provider: "openrouter",
  //   model: "openai/gpt-oss-20b:free",
  //   structured: false,
  //   reasoning: true,
  //   tier: "standard",
  // },
  // {
  //   id: "north-mini",
  //   label: "North Mini",
  //   hint: "Compact, strong on detail.",
  //   provider: "openrouter",
  //   model: "cohere/north-mini-code:free",
  //   structured: false,
  //   tier: "standard",
  // },
];

/**
 * Whether a provider has the keys it needs.
 *
 * Every branch but `cloudflare` is unreachable while the catalogue above is
 * Cloudflare-only — nothing asks about a provider no model claims. They stay
 * because they are the other half of restoring a commented-out entry: uncomment
 * the model, set its key, and this already answers correctly. The provider
 * clients in `ask.ts` are here for the same reason.
 */
export function providerReady(provider: ModelProvider): boolean {
  switch (provider) {
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    case "nvidia":
      return Boolean(process.env.NVIDIA_API_KEY);
    case "cloudflare":
      return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
    default:
      return Boolean(process.env.OPENROUTER_API_KEY);
  }
}

 
export function availableModels(_tier?: OrbitTier): OrbitModel[] {
  return ORBIT_MODELS.filter((m) => providerReady(m.provider));
}

 
export function cloudflareModelIds(): string[] {
  return ORBIT_MODELS.filter((m) => m.provider === "cloudflare").map((m) => m.id);
}

/** The ids of every model NOT served by Cloudflare — the `exclude` list for a CF-only call. */
export function nonCloudflareModelIds(): string[] {
  return ORBIT_MODELS.filter((m) => m.provider !== "cloudflare").map((m) => m.id);
}

 
export function resolveModel(id?: string, tier?: OrbitTier): OrbitModel | undefined {
  const available = availableModels(tier);
  return available.find((m) => m.id === id) ?? available[0];
}

 
export function fallbackChain(chosen: OrbitModel, tier?: OrbitTier): OrbitModel[] {
  return [chosen, ...availableModels(tier).filter((m) => m.id !== chosen.id)];
}

 
export function structuredModelId(id?: string): string | undefined {
  if (!id) return undefined;
  const model = availableModels().find((m) => m.id === id);
  return model?.structured ? model.id : undefined;
}
