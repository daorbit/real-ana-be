/**
 * Cleaning up what a language model actually returns.
 *
 * Asking five models for the same JSON shape gets five dialects of it. Some
 * honour a schema; some wrap the object in a ``` fence; some emit the fence
 * with a language tag; some answer in prose and ignore the shape entirely; and
 * some — the failure this module was written for — return a JSON object whose
 * `reply` is *itself* a serialised JSON object, so one parse leaves the user
 * reading `{"reply":"To fix your SEO…` in the chat window.
 *
 * The rule throughout: never lose a usable answer over its formatting. A model
 * that returned prose instead of the agreed envelope has still answered the
 * question, and showing that text beats showing an error. Only genuinely empty
 * output is a failure worth passing back.
 *
 * Kept apart from `orbit.ts` because none of this is Orbit-specific — it is the
 * general problem of taking text from a model and getting a known shape out of
 * it, and it is the kind of code that earns its own tests.
 */

/** How many times to unwrap a reply that turns out to be more JSON. */
const MAX_UNWRAP_DEPTH = 3;

/**
 * Strip a markdown code fence, if the whole string is wrapped in one.
 *
 * Models that cannot be schema-constrained routinely answer with
 * ```json\n{…}\n``` — the fence is formatting they were never asked for, and it
 * is what makes an otherwise valid object fail to parse.
 *
 * Only a fence enclosing the entire string is removed. A fence *inside* an
 * answer is a code sample the user asked for, and stripping it would corrupt
 * the very thing they need to copy.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\s*\n?([\s\S]*?)\n?\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Parse JSON that may be fenced, or may not be JSON at all.
 *
 * Returns null rather than throwing: a model returning prose is an expected
 * outcome here, not an exception.
 */
export function parseLooseJson<T = unknown>(text: string): T | null {
  const cleaned = stripCodeFence(text);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve a field that may have been serialised more than once.
 *
 * The case this exists for: a model is asked for `{reply, suggestions}`, and
 * returns `{"reply": "{\"reply\":\"…\",\"suggestions\":[]}"}` — the object it
 * was asked for, wrapped in another copy of itself. Parsing once gives a string
 * that is still JSON, and rendering it puts raw JSON in front of the user.
 *
 * So the value is unwrapped while it keeps looking like the envelope, up to a
 * small depth. Bounded because an unbounded loop on hostile input is how a
 * cleanup routine becomes a denial of service, and three is already more
 * nesting than any real model produces.
 *
 * `key` names the field to keep descending into.
 */
export function unwrapNested(
  value: unknown,
  key: string,
  depth = MAX_UNWRAP_DEPTH,
): unknown {
  if (depth <= 0 || typeof value !== "string") return value;

  const trimmed = stripCodeFence(value);
  // Cheap guard before attempting a parse: an answer that merely mentions JSON
  // should not be run through the parser on every call.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;

  const parsed = parseLooseJson<Record<string, unknown>>(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
  if (!(key in parsed)) return value;

  return unwrapNested(parsed[key], key, depth - 1);
}

/**
 * Tidy a string that is going to be rendered as prose.
 *
 * Deliberately minimal. This is someone's answer, and a cleanup routine that
 * rewrites wording is worse than the untidiness it fixes — so it only removes
 * artefacts of the transport: stray fences, zero-width characters that break
 * text selection, and runs of blank lines from a model padding its output.
 *
 * Note what is *not* done here: turning a literal backslash-n into a newline.
 * That looks like an obvious tidy-up and is a bug. Inside a JSON string, `\n`
 * is a valid escape that `JSON.parse` already resolves — so unescaping here
 * would corrupt the envelope before it could be parsed, and would also mangle
 * any answer that legitimately contains the characters, such as a code sample
 * showing an escape sequence.
 */
export function tidyProse(text: string): string {
  return (
    stripCodeFence(text)
      // Zero-width space, joiner, non-joiner, BOM. Invisible, and they break
      // search, copy and word wrapping wherever they land.
      .replace(/[​-‍﻿]/g, "")
      .replace(/\r\n?/g, "\n")
      // Three or more newlines is padding, not paragraphing.
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trim()
  );
}

/**
 * The envelope every Orbit answer is reduced to.
 *
 * `reply` is guaranteed non-empty when this returns a value; `suggestions` is
 * always an array, possibly empty.
 */
export type ModelAnswer = {
  reply: string;
  suggestions: string[];
};

export type SanitiseOptions = {
  /** Drop suggestions longer than this. They have to fit a narrow panel. */
  maxSuggestionChars?: number;
  maxSuggestions?: number;
  /** Hard cap on the reply, as a backstop against a runaway generation. */
  maxReplyChars?: number;
};

/**
 * Turn whatever a model returned into an answer worth rendering.
 *
 * Handles, in order: a fenced or bare JSON envelope, a `reply` that is itself
 * more JSON, and plain prose from a model that ignored the shape. Returns null
 * only when there is no usable text at all — which is the caller's signal to
 * try a different model rather than to show an error.
 */
export function sanitiseModelAnswer(
  raw: string,
  options: SanitiseOptions = {},
): ModelAnswer | null {
  const {
    maxSuggestionChars = 80,
    maxSuggestions = 3,
    maxReplyChars = 4000,
  } = options;

  if (!raw?.trim()) return null;

  const parsed = parseLooseJson<Record<string, unknown>>(raw);

  // No envelope at all. The model answered in prose, which is still an answer.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const reply = tidyProse(raw).slice(0, maxReplyChars);
    return reply ? { reply, suggestions: [] } : null;
  }

  // The double-encoding case: `reply` holding another serialised envelope.
  const unwrapped = unwrapNested(parsed.reply, "reply");
  const reply = typeof unwrapped === "string" ? tidyProse(unwrapped).slice(0, maxReplyChars) : "";

  if (!reply) return null;

  // Suggestions can be nested the same way the reply was, so they are read from
  // whichever envelope actually carried the text.
  const source = findSuggestions(parsed) ?? [];
  const suggestions = source
    .filter((s): s is string => typeof s === "string")
    .map((s) => tidyProse(s))
    .filter((s) => s.length > 0 && s.length <= maxSuggestionChars)
    .slice(0, maxSuggestions);

  return { reply, suggestions };
}

/**
 * Find the suggestions array, wherever the model put it.
 *
 * When the envelope is double-encoded, the outer object's `suggestions` is
 * usually the empty one — the real list is inside the string that held the
 * reply. This looks at the outer object first, then descends.
 */
function findSuggestions(
  envelope: Record<string, unknown>,
  depth = MAX_UNWRAP_DEPTH,
): unknown[] | null {
  if (Array.isArray(envelope.suggestions) && envelope.suggestions.length > 0) {
    return envelope.suggestions;
  }
  if (depth <= 0 || typeof envelope.reply !== "string") return null;

  const inner = parseLooseJson<Record<string, unknown>>(envelope.reply);
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;

  return findSuggestions(inner, depth - 1);
}
