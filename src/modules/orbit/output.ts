
const MAX_UNWRAP_DEPTH = 3;


export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\s*\n?([\s\S]*?)\n?\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}


export function parseLooseJson<T = unknown>(text: string): T | null {
  const cleaned = stripCodeFence(text);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}


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


export function salvageTruncatedEnvelope(text: string): string | null {
  const trimmed = stripCodeFence(text);
  if (!trimmed.startsWith("{")) return null;
  // Complete JSON is somebody else's job.
  if (parseLooseJson(trimmed) !== null) return null;

  const opening = /^\{\s*(?:"reply"|'reply'|reply)\s*:\s*"/.exec(trimmed);
  if (!opening) return null;

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


export function reformatSearchDump(text: string): string {
  const pattern = /^1\.\s(.+)\n((?:(?!^1\.\s|^Source:).*\n)*?)^Source:\s*(\S+)\s*$/gim;
  let index = 0;
  let sawMatch = false;

  const out = text.replace(pattern, (_match, title: string, body: string, url: string) => {
    sawMatch = true;
    index += 1;
    const label = title.trim().replace(/[.:]+$/, "");
    return `${index}. ${title.trim()}\n${body}[${label}](${url.trim()})`;
  });

  return sawMatch ? out : text;
}


export function linkifyBareUrls(text: string): string {
  return text.replace(
    /(^|[^[])\b([A-Za-z0-9][\w .'-]{0,80}?)\s*\((https?:\/\/[^\s()]+)\)/g,
    (match, before: string, label: string, url: string) => `${before}[${label.trim()}](${url})`,
  );
}

export function tidyProse(text: string): string {
  return (
    linkifyBareUrls(reformatSearchDump(stripCodeFence(text)))
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

export function sanitiseModelAnswer(
  raw: string,
  options: SanitiseOptions = {},
): ModelAnswer | null {
  const {
    maxSuggestionChars = 80,
    maxSuggestions = 3,

    maxReplyChars = 12000,
  } = options;

  if (!raw?.trim()) return null;

  const limits = { maxSuggestionChars, maxSuggestions, maxReplyChars };
  const parsed = parseLooseJson<Record<string, unknown>>(raw);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return fromEnvelope(parsed, limits);
  }


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


function fromEnvelope(
  envelope: Record<string, unknown>,
  { maxSuggestionChars, maxSuggestions, maxReplyChars }: Limits,
): ModelAnswer | null {
  // The double-encoding case: `reply` holding another serialised envelope.
  const unwrapped = unwrapNested(envelope.reply, "reply");
  const rawReply =
    typeof unwrapped === "string" ? tidyProse(unwrapped).slice(0, maxReplyChars) : "";

  if (!rawReply) return null;


  const source = findSuggestions(envelope) ?? [];
  const suggestions = source
    .filter((s): s is string => typeof s === "string")
    .map((s) => tidyProse(s))
    .filter((s) => s.length > 0 && s.length <= maxSuggestionChars)
    .slice(0, maxSuggestions);

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


function splitTrailingQuestions(reply: string): { reply: string; questions: string[] } {

  const headed =
    /\n[ \t]*(?:\*\*|##+[ \t]*)?[A-Za-z ]{0,40}?(?:suggestions?|follow[- ]?ups?|related questions?|next steps?)[^\n:]{0,40}?:(?:\*\*)?[ \t]*\n([\s\S]+)$/i.exec(
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

  const inlineList =
    /\n[ \t]*(?:\*\*)?(?:suggestions?|follow[- ]?ups?(?:\s+questions?)?|related questions?)(?:\*\*)?[ \t]*:[ \t]*(.+?)[ \t]*$/i.exec(
      reply,
    );

  if (inlineList) {
    // Split on real separators only — a comma, a semicolon, or a pipe. Not
    // "and": "add and remove a site" is one suggestion, and the models that
    // use this form reliably comma-separate.
    const items = inlineList[1]
      .split(/\s*(?:,|;|\|)\s*/)
      .map((l) => l.replace(/^["'“]|["'”.]$/g, "").trim())
      .filter((l) => l.length > 0 && l.length <= 80);

    const body = reply.slice(0, inlineList.index).trim();
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
