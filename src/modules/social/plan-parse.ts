/**
 * Reading the plan object out of a model's reply.
 *
 * Orbit's envelope is fixed at `{ reply, suggestions }`, so a route that wants
 * structured data has to ask for JSON *inside* the `reply` string — which means
 * the model has to escape a JSON document into a JSON string field. Models are
 * unreliable at that, and the unstructured ones in the fallback chain never see
 * the schema at all: they answer with a fence, or with a sentence before the
 * object, or with the braces unescaped so the envelope itself carries the keys.
 *
 * A single `JSON.parse` of the whole reply fails on all three, which is what
 * made the scheduler answer "Orbit could not follow that" every time. This
 * tries the shapes they actually produce, in order of likelihood.
 */

/** A brace-balanced scan, so a `{` inside a caption cannot truncate the object. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    // Braces inside a string are part of the prose, not the structure.
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** Strip a ```json fence, which several models add despite being told not to. */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * The plan object, from whatever the model actually returned.
 *
 * `reply` is the envelope's own field; `envelope` is the parsed envelope, which
 * is checked as a fallback — a model that ignored the instruction and answered
 * with the plan keys at the top level has still produced a usable plan, and
 * refusing it would send the author back to a form they were trying to skip.
 */
export function parsePlan(
  reply: string,
  envelope?: Record<string, unknown>,
): Record<string, unknown> | null {
  const candidates: string[] = [];

  const cleaned = stripFence(reply.trim());
  candidates.push(cleaned);

  const scanned = firstJsonObject(cleaned);
  if (scanned && scanned !== cleaned) candidates.push(scanned);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        // A model that double-encoded — a JSON string containing JSON — gives
        // back a string here rather than an object.
        if (typeof obj.reply === "string" && !("caption" in obj)) {
          const inner = parsePlan(obj.reply);
          if (inner) return inner;
        }
        return obj;
      }
      if (typeof parsed === "string") {
        const inner = parsePlan(parsed);
        if (inner) return inner;
      }
    } catch {
      // Try the next shape.
    }
  }

  // Last resort: the model put the plan's keys on the envelope itself.
  if (envelope && ("caption" in envelope || "message" in envelope)) return envelope;

  return null;
}
