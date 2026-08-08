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
 * Find an envelope a model appended to its own prose answer.
 *
 * The failure this exists for: a weaker model writes the answer as prose, then —
 * because it was asked for an object — restates the whole thing as a fenced
 * ```json block underneath. Neither branch of `sanitiseModelAnswer` caught it:
 * the string as a whole is not JSON, and the fence does not wrap the *entire*
 * string, so `stripCodeFence` leaves it alone and the user reads the answer
 * followed by a slab of raw JSON.
 *
 * The block is the model's own restatement, not content the user asked for, so
 * the right move is to prefer it and drop the prose — it carries the
 * `suggestions` the prose version lost.
 *
 * Deliberately narrow. Only a fenced object at the very *end* of the text
 * qualifies, and only one that actually has a usable `reply`. A JSON sample in
 * the middle of an answer is something the user needs to copy, and an arbitrary
 * object at the end (a config example closing an answer) is not an envelope
 * either — both are left where they are.
 */
export function extractTrailingEnvelope(
  text: string,
): { envelope: Record<string, unknown>; prose: string } | null {
  const trimmed = text.trimEnd();
  // Anchored to the end, and the body must open with `{` — a trailing fence of
  // shell commands or HTML is part of the answer.
  const match = /\n\s*```(?:json)?\s*\n(\{[\s\S]*?\})\s*```$/i.exec(trimmed);
  if (!match) return null;

  const envelope = parseLooseJson<Record<string, unknown>>(match[1]);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  // Without a reply it is some other object that happened to end the answer.
  if (typeof envelope.reply !== "string" || !envelope.reply.trim()) return null;

  return { envelope, prose: trimmed.slice(0, match.index).trim() };
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // The inner copy was cut off mid-generation. This is the common shape of
    // the double-encoding failure: the outer envelope closed because it was
    // short, while the serialised one inside it ran out of tokens. Recover the
    // text rather than handing back JSON source to be rendered.
    return key === "reply" ? (salvageTruncatedEnvelope(trimmed) ?? value) : value;
  }
  if (!(key in parsed)) return value;

  return unwrapNested(parsed[key], key, depth - 1);
}

/**
 * Recover the reply from an envelope that was cut off mid-generation.
 *
 * A model that hits its token ceiling while writing `{"reply": "…"}` leaves a
 * string with no closing quote and no brace. Nothing can parse it, so every
 * path above falls through to treating it as prose — and the user reads
 * `{"reply":"To install Quantalog…` verbatim in the chat window.
 *
 * The answer itself is sitting right there, just missing its terminator, so
 * this lifts the value of the first `reply` key and unescapes it by hand. The
 * text was written for the user; only its wrapper failed.
 *
 * Deliberately narrow: the string must *open* with the envelope, which is what
 * separates a broken wrapper from an answer that merely quotes JSON. A complete
 * envelope never reaches here — `parseLooseJson` handles those — so matching
 * only unterminated input costs nothing in the normal case.
 */
export function salvageTruncatedEnvelope(text: string): string | null {
  const trimmed = stripCodeFence(text);
  if (!trimmed.startsWith("{")) return null;
  // Complete JSON is somebody else's job.
  if (parseLooseJson(trimmed) !== null) return null;

  const opening = /^\{\s*(?:"reply"|'reply'|reply)\s*:\s*"/.exec(trimmed);
  if (!opening) return null;

  // Walk the string body, honouring escapes, until the closing quote or the end
  // of what we were given. Scanning by hand rather than by regex because the
  // whole point is that this input is malformed: `[\s\S]*?"` would stop at the
  // first escaped quote inside the answer and truncate it further.
  let out = "";
  for (let i = opening[0].length; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (ch === "\\") {
      const next = trimmed[++i];
      if (next === undefined) break; // trailing backslash: the cut landed here
      out +=
        next === "n" ? "\n"
        : next === "t" ? "\t"
        : next === "r" ? "\r"
        : next === "u" ? String.fromCharCode(parseInt(trimmed.slice(i + 1, i + 5), 16) || 0)
        : next;
      if (next === "u") i += 4;
      continue;
    }

    if (ch === '"') break; // the value closed; anything after is envelope
    out += ch;
  }

  const salvaged = out.trim();
  // A few stray characters are the start of an answer we did not really get.
  return salvaged.length >= 20 ? salvaged : null;
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

  const limits = { maxSuggestionChars, maxSuggestions, maxReplyChars };
  const parsed = parseLooseJson<Record<string, unknown>>(raw);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return fromEnvelope(parsed, limits);
  }

  // Not an envelope on its own. Before treating it as prose, check whether the
  // model wrote the answer twice — once as prose and once as a fenced object
  // underneath it. That block is the model restating itself, and it carries the
  // suggestions the prose copy dropped, so it is the better source.
  // A response that is an envelope but could not be parsed is almost always one
  // that ran out of tokens while writing it. Recovering the reply beats
  // rendering the JSON source, and beats discarding an answer we already paid
  // for. Suggestions are lost with the tail, so the trailing-question split is
  // the only chance of recovering any.
  const salvaged = salvageTruncatedEnvelope(raw);
  if (salvaged) return asProse(salvaged, limits);

  const trailing = extractTrailingEnvelope(raw);
  if (trailing) {
    const fromBlock = fromEnvelope(trailing.envelope, limits);
    if (fromBlock) return fromBlock;

    // The block was unusable after tidying. The prose above it is still a real
    // answer, so fall through on that rather than losing the response.
    if (trailing.prose) return asProse(trailing.prose, limits);
  }

  return asProse(raw, limits);
}

type Limits = Required<SanitiseOptions>;

/**
 * Read the agreed shape out of a parsed envelope.
 *
 * Split out because the envelope can arrive two ways — as the whole response, or
 * as a block appended to a prose answer — and both need identical treatment of
 * double-encoding, limits and misplaced follow-ups.
 */
function fromEnvelope(
  envelope: Record<string, unknown>,
  { maxSuggestionChars, maxSuggestions, maxReplyChars }: Limits,
): ModelAnswer | null {
  // The double-encoding case: `reply` holding another serialised envelope.
  const unwrapped = unwrapNested(envelope.reply, "reply");
  const rawReply =
    typeof unwrapped === "string" ? tidyProse(unwrapped).slice(0, maxReplyChars) : "";

  if (!rawReply) return null;

  // Suggestions can be nested the same way the reply was, so they are read from
  // whichever envelope actually carried the text.
  const source = findSuggestions(envelope) ?? [];
  const suggestions = source
    .filter((s): s is string => typeof s === "string")
    .map((s) => tidyProse(s))
    .filter((s) => s.length > 0 && s.length <= maxSuggestionChars)
    .slice(0, maxSuggestions);

  // A model that filled the envelope correctly is trusted as-is. One that left
  // `suggestions` empty usually wrote them at the end of the reply instead,
  // where they read as the answer trailing off into orphan questions.
  if (suggestions.length > 0) return { reply: rawReply, suggestions };

  const split = splitTrailingQuestions(rawReply);
  return {
    reply: split.reply,
    suggestions: split.questions.slice(0, maxSuggestions),
  };
}

/**
 * Treat the response as prose from a model that ignored the shape entirely.
 *
 * Still an answer, and it may have the follow-ups appended to the end of it.
 */
function asProse(
  text: string,
  { maxSuggestions, maxReplyChars }: Limits,
): ModelAnswer | null {
  const tidied = tidyProse(text).slice(0, maxReplyChars);
  if (!tidied) return null;

  const split = splitTrailingQuestions(tidied);
  return {
    reply: split.reply,
    suggestions: split.questions.slice(0, maxSuggestions),
  };
}

/**
 * Pull follow-up questions out of the end of a reply.
 *
 * A model that ignored the envelope often still produces the follow-ups — it
 * just appends them to the prose instead of putting them in `suggestions`. The
 * result is a reply that trails off into two orphan questions and an empty
 * suggestions array, so the chips never render and the answer looks like it ran
 * on past its ending.
 *
 * Only trailing lines are considered, and only ones that read as a whole
 * question on their own line. A question *inside* the answer — "What does that
 * mean? It means…" — is part of the explanation and is left alone.
 *
 * Returns the trimmed reply and whatever was lifted off the end.
 */
function splitTrailingQuestions(reply: string): { reply: string; questions: string[] } {
  // The explicit form first: a model that wrote its own "Suggestions" heading
  // and listed them under it. Everything from the heading down is not part of
  // the answer, whatever shape the items take.
  // The optional trailing "questions" matters: models write "Follow-up
  // questions" at least as often as "Follow-ups", and missing it sends the
  // whole block down the line-walker, which only strips the last few lines and
  // leaves the heading stranded at the end of the answer.
  const headed =
    /\n\s*(?:\*\*|##+\s*)?(?:suggestions?|follow[- ]?ups?(?:\s+questions?)?|related questions?|next steps?)(?:\*\*)?\s*:?\s*\n([\s\S]+)$/i.exec(
      reply,
    );

  if (headed) {
    const items = headed[1]
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .map((l) => l.replace(/^["'“]|["'”]$/g, "").trim())
      .filter((l) => l.length > 0 && l.length <= 80);

    const body = reply.slice(0, headed.index).trim();
    if (body && items.length > 0) return { reply: body, questions: items.slice(0, 3) };
  }

  const lines = reply.split("\n");
  const questions: string[] = [];

  // Walk backwards while the last non-empty line still looks like a follow-up.
  while (lines.length > 0) {
    const line = lines[lines.length - 1].trim();

    if (!line) {
      lines.pop();
      continue;
    }

    const isQuestion =
      line.endsWith("?") &&
      // A follow-up is short. A long question is the model explaining
      // something, and cutting it would remove part of the answer.
      line.length <= 80 &&
      // Bullets and numbers mean it belongs to a list in the answer body.
      !/^[-*\d]/.test(line) &&
      // Two sentences is prose, not a suggestion chip.
      !/[.!]\s/.test(line);

    if (!isQuestion) break;

    questions.unshift(line.replace(/^["'“]|["'”]$/g, "").trim());
    lines.pop();

    // Three is the cap everywhere else; stop rather than eating the answer.
    if (questions.length >= 3) break;
  }

  // Only accept the split if something is left. An answer that is *only*
  // questions was never a list of suggestions — it is the reply.
  const remaining = lines.join("\n").trim();
  return remaining ? { reply: remaining, questions } : { reply, questions: [] };
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
