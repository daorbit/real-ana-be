/**
 * Orbit AI — the model call behind the in-app assistant.
 *
 * Talks to Gemini over plain HTTPS rather than through the SDK: this is one
 * POST with a JSON body, and a dependency that has to be kept in step with a
 * fast-moving API is a poor trade for the twenty lines it would save.
 *
 * The key is read from the environment on every call rather than captured at
 * import. That keeps a rotated key working after a restart without a rebuild,
 * and it means a missing key is a runtime "not configured" the route can report
 * instead of a crash at boot.
 */

import { ORBIT_SYSTEM_PROMPT } from "./orbit-knowledge.js";

/**
 * The model.
 *
 * "flash-latest" rather than a pinned version: this answers support questions
 * from a supplied document, which is the workload least sensitive to a model
 * revision, and the alias means it does not silently stay on something
 * deprecated. Overridable for when that stops being true.
 */
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** How long to wait on the model before giving up on the user's behalf. */
const TIMEOUT_MS = 20_000;

/** One turn of the conversation. */
export type OrbitTurn = {
  role: "user" | "assistant";
  content: string;
};

export type OrbitResult =
  | { ok: true; reply: string; suggestions: string[] }
  | { ok: false; error: string; status: number };

/** At most this many follow-ups. Three fits the panel; more is a menu. */
const MAX_SUGGESTIONS = 3;

/** Whether the assistant can run at all. Routes check this before accepting a question. */
export function orbitConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Read the model's JSON answer.
 *
 * The schema constrains the shape, but the response is still parsed
 * defensively: a truncated answer is valid text and invalid JSON, and losing a
 * perfectly good reply because the follow-ups did not fit is the wrong failure.
 * So a parse error falls back to treating the whole thing as the reply.
 */
function parseAnswer(raw: string): OrbitResult {
  try {
    const parsed = JSON.parse(raw) as { reply?: unknown; suggestions?: unknown };
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";

    if (!reply) {
      return { ok: false, error: "Orbit had nothing to say to that. Try rephrasing it.", status: 502 };
    }

    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          // A suggestion has to fit a chip in a 400px panel. Anything longer is
          // the model writing a sentence where a question was asked for.
          .filter((s) => s.length > 0 && s.length <= 80)
          .slice(0, MAX_SUGGESTIONS)
      : [];

    return { ok: true, reply, suggestions };
  } catch {
    // Not JSON. Almost always a truncation, and the text is still the answer.
    return { ok: true, reply: raw, suggestions: [] };
  }
}

/**
 * Ask Orbit a question, with the conversation so far for context.
 *
 * `history` is oldest-first and excludes the current question, which is passed
 * separately — the caller should not have to remember to append it in the right
 * shape.
 */
export async function askOrbit(
  question: string,
  history: OrbitTurn[] = [],
): Promise<OrbitResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { ok: false, error: "Orbit is not configured on this server.", status: 503 };
  }

  // Gemini calls the assistant role "model", and takes the system instruction
  // as its own top-level field rather than as a first turn.
  const contents = [...history, { role: "user" as const, content: question }].map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));

  // Without an explicit abort, a hung upstream request holds the socket until
  // the platform's own timeout, and the user watches a spinner the whole time.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT(MODEL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ORBIT_SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          // Low, not zero. Support answers should be stable and factual; zero
          // makes a model repeat an unhelpful phrasing verbatim when a user
          // rewords the same question.
          temperature: 0.3,
          // Enough for a short answer plus its follow-ups. The prompt asks for
          // brevity; this is the backstop when it is ignored.
          maxOutputTokens: 900,
          // Structured output rather than asking for JSON in the prompt and
          // hoping. The model is constrained to this shape, so the suggestions
          // arrive as data instead of being scraped out of prose — which is
          // what breaks the first time an answer happens to contain a list.
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              reply: { type: "STRING" },
              suggestions: {
                type: "ARRAY",
                items: { type: "STRING" },
              },
            },
            required: ["reply", "suggestions"],
          },
        },
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Logged with the upstream status, never returned: the body can carry key
      // material and quota details that are nobody's business but ours.
      console.error(`[orbit] gemini responded ${res.status}:`, detail.slice(0, 500));

      // 429 is the one worth telling the truth about — it is temporary and the
      // user's own next move (wait, retry) depends on knowing that.
      if (res.status === 429) {
        return {
          ok: false,
          error: "Orbit is busy right now. Try again in a moment.",
          status: 429,
        };
      }
      return {
        ok: false,
        error: "Orbit could not answer that. Try again, or use Email support.",
        status: 502,
      };
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };

    const raw = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!raw) {
      // An empty candidate usually means the safety filter caught something, or
      // the answer was cut off before any text was produced.
      return {
        ok: false,
        error: "Orbit had nothing to say to that. Try rephrasing it.",
        status: 502,
      };
    }

    return parseAnswer(raw);
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("[orbit] request failed:", e instanceof Error ? e.message : e);
    return {
      ok: false,
      error: aborted
        ? "Orbit took too long to answer. Try again."
        : "Orbit is unreachable right now. Try again, or use Email support.",
      status: aborted ? 504 : 502,
    };
  } finally {
    clearTimeout(timer);
  }
}
