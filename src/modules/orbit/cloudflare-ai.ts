/**
 * Cloudflare Workers AI, as an OpenAI-shaped chat completion.
 *
 * A third provider behind Orbit's chain, and the reason for adding it is
 * latency rather than capability: the social scheduler's plan route measured
 * 17-31s per attempt against the OpenRouter models on 2026-08-28, varying run
 * to run on identical input, which is longer than someone watching a chat panel
 * will wait and long enough that two attempts overrun any sane request budget.
 *
 * Cloudflare's API is not OpenAI-shaped — it takes `{ messages }` at the top
 * level and answers `{ result: { response } }` — so the translation lives here
 * rather than leaking a third request shape into `ask.ts`.
 */

/** What a chat call needs, in the vocabulary the caller already uses. */
export interface CloudflareChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
  /** Aborts the request when the caller's own budget runs out. */
  signal?: AbortSignal;
}

export type CloudflareChatResult =
  | { ok: true; text: string }
  | { ok: false; status: number; detail: string };

/**
 * Whether the account and token are both configured.
 *
 * Checked before the model list offers anything on this provider, so a missing
 * key is a model that never appears rather than one that always fails.
 */
export function cloudflareReady(): boolean {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
}

/**
 * One chat completion.
 *
 * Errors are returned rather than thrown, matching how the rest of the chain
 * reports a refusal: a failed model is a turn passed to the next one, not an
 * exception the route has to catch.
 */
export async function cloudflareChat(
  req: CloudflareChatRequest,
): Promise<CloudflareChatResult> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!token) return { ok: false, status: 503, detail: "no CLOUDFLARE_API_TOKEN" };
  if (!account) return { ok: false, status: 503, detail: "no CLOUDFLARE_ACCOUNT_ID" };

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${req.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        }),
        signal: req.signal,
      },
    );

    const body = await res.text();

    if (!res.ok) {
      // The body carries the account id in its error envelope, so it is
      // returned for logging only — the same rule the other providers follow.
      return { ok: false, status: res.status, detail: body.slice(0, 300) };
    }

    // Two shapes in the wild: the native `result.response`, and an
    // OpenAI-compatible `result.choices[]` on the newer chat models. Both are
    // accepted rather than pinned to one, since which a model returns is a
    // property of the model and changes without notice.
    const data = JSON.parse(body) as {
      result?: {
        response?: unknown;
        choices?: { message?: { content?: string } }[];
      };
    };

    // `result.response` is a string on most models but an already-parsed object
    // on some — Llama 3.3 returns the JSON it was asked for as an object, and
    // stringifying that with `String()` yields "[object Object]", which reaches
    // the plan parser as garbage and costs the model its turn. The
    // OpenAI-shaped `choices[]` is preferred where present because it is always
    // a string; an object response is re-serialised rather than coerced.
    const raw = data.result?.choices?.[0]?.message?.content ?? data.result?.response;

    const text =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
          ? JSON.stringify(raw)
          : "";

    if (!text.trim()) return { ok: false, status: 502, detail: "empty completion" };

    return { ok: true, text };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      detail: e instanceof Error ? e.message : "request failed",
    };
  }
}
