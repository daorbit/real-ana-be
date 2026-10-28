import { cloudflareChat, cloudflareReady, cloudflareVisionChat } from "../orbit/cloudflare-ai.js";
import { extractJson } from "../forms-ai/generate.js";

const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"];
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const ATTEMPT_TIMEOUT_MS = 20_000;
const VISION_TIMEOUT_MS = 30_000;

export type Message = { role: string; content: string };

export type ModelAnswer<T> = { ok: true; value: T; model: string } | { ok: false; detail: string };

export function invoicesAiReady(): boolean {
  return cloudflareReady();
}

export async function askJson<T>(
  messages: Message[],
  read: (raw: unknown) => T | null,
  maxTokens: number,
): Promise<ModelAnswer<T>> {
  let detail = "";
  for (const model of MODELS) {
    const res = await cloudflareChat({
      model,
      messages,
      maxTokens,
      temperature: 0.2,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!res.ok) {
      detail = `${model}: ${res.detail}`;
      continue;
    }
    const value = read(extractJson(res.text));
    if (value) return { ok: true, value, model };
    detail = `${model}: unusable reply — ${res.text.slice(0, 300)}`;
  }
  return { ok: false, detail };
}

export async function askVisionJson<T>(
  prompt: string,
  image: string,
  read: (raw: unknown) => T | null,
  maxTokens: number,
): Promise<ModelAnswer<T>> {
  const res = await cloudflareVisionChat({
    model: VISION_MODEL,
    image,
    prompt,
    maxTokens,
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, detail: `${VISION_MODEL}: ${res.detail.slice(0, 300)}` };
  const value = read(extractJson(res.text));
  return value ? { ok: true, value, model: VISION_MODEL } : { ok: false, detail: `${VISION_MODEL}: unusable reply` };
}
