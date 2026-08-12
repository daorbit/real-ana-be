import {
  CHOICE_TYPES,
  COMPOSITE_PARTS,
  isCompositeType,
  type FieldType,
} from "./models/Form.js";

/**
 * Turning one submitted value into the answer that gets stored.
 *
 * Its own module because it is the trust boundary. Everything here runs against
 * input from an unauthenticated endpoint, so nothing is taken on the caller's
 * word: the type comes from the stored field rather than the payload, every
 * string is length-capped, every number is range-checked, and a choice is
 * matched against the options the form actually offers.
 *
 * The other half of the boundary is what is *not* here — none of these values
 * is ever rendered as HTML, in the dashboard, the notification email, or the
 * CSV. That is what makes storing arbitrary text safe.
 */

/** The subset of a field definition validation needs. */
export type FieldSpec = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  maxLength: number;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  ratingMax?: number;
  pattern?: string;
  patternMessage?: string;
  minDate?: string;
  maxDate?: string;
  parts?: string[];
  currency?: string;
  maxFileMb?: number;
  acceptedTypes?: string[];
};

export type AnswerResult = { ok: true; value: unknown } | { ok: false; error: string };

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/** A value the visitor left alone, for any type. */
function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === "";
}

/**
 * A URL a person typed, accepted only if it is http(s).
 *
 * Scheme-checked rather than pattern-matched because this value is later shown
 * to the form's owner as something they might click: `javascript:` in a
 * "Website" field is a stored payload aimed at whoever reads the response.
 */
function checkUrl(text: string): string | null {
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Match a form owner's pattern against a stranger's input, with a length guard.
 *
 * The pattern is trusted input (the owner wrote it) applied to untrusted input
 * (the visitor typed it), which is where catastrophic backtracking lives. Node
 * has no regex timeout, so the defences are: the pattern is capped at 200
 * characters when saved, the subject is capped here, and an invalid pattern
 * fails open rather than rejecting every answer — an owner who typed a broken
 * regex should not silently lose every lead.
 */
function matchesPattern(pattern: string, text: string): boolean {
  if (!pattern) return true;
  if (text.length > 500) return false;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return true;
  }
}

/** ISO date comparison that tolerates a `datetime-local` value. */
function withinDateBounds(text: string, minDate?: string, maxDate?: string): boolean {
  const value = Date.parse(text);
  if (!Number.isFinite(value)) return false;
  if (minDate) {
    const min = Date.parse(minDate);
    if (Number.isFinite(min) && value < min) return false;
  }
  if (maxDate) {
    const max = Date.parse(maxDate);
    if (Number.isFinite(max) && value > max) return false;
  }
  return true;
}

/** The parts of a composite field this form actually asks for. */
export function activeParts(field: FieldSpec): { key: string; label: string; width: number }[] {
  const all = COMPOSITE_PARTS[field.type] ?? [];
  // Empty means every part — which is what a field saved before `parts` existed
  // has, and the right default for one.
  if (!field.parts?.length) return all;
  return all.filter((p) => field.parts!.includes(p.key));
}

export function coerceAnswer(field: FieldSpec, raw: unknown): AnswerResult {
  if (isCompositeType(field.type)) return coerceComposite(field, raw);

  switch (field.type) {
    /**
     * The three boolean-ish types.
     *
     * `terms` is separated from `checkbox` because a required consent box that
     * is not ticked is not a missing answer — it is a refusal, and it deserves
     * to say so rather than "this field is required".
     */
    case "checkbox":
    case "yesno": {
      const checked = raw === true || raw === "true" || raw === "on" || raw === "1" || raw === "yes";
      if (field.required && !checked) return { ok: false, error: `"${field.label}" is required` };
      return { ok: true, value: checked };
    }
    case "terms": {
      const agreed = raw === true || raw === "true" || raw === "on" || raw === "1";
      if (field.required && !agreed)
        return { ok: false, error: `Please accept "${field.label}" to continue` };
      return { ok: true, value: agreed };
    }

    case "file":
    case "image": {
      // The browser uploads to storage first and submits the resulting URL, so
      // what arrives here is a reference rather than bytes. It is checked
      // against our own storage host: an arbitrary URL accepted here would let
      // anyone use a lead form to plant a link on someone else's dashboard.
      if (isBlank(raw)) {
        if (field.required) return { ok: false, error: `"${field.label}" is required` };
        return { ok: true, value: "" };
      }
      const url = str(raw, 600);
      if (!/^https:\/\/res\.cloudinary\.com\//i.test(url))
        return { ok: false, error: `"${field.label}" was not uploaded correctly — try again` };
      return { ok: true, value: url };
    }

    default:
      break;
  }

  // Everything below stores text or a number, so a blank is the same question
  // for all of them: was it required.
  const text = str(raw, Math.max(field.maxLength || 500, 1));
  if (!text) {
    if (field.required) return { ok: false, error: `"${field.label}" is required` };
    return { ok: true, value: "" };
  }

  switch (field.type) {
    case "email":
      if (!looksLikeEmail(text))
        return { ok: false, error: `"${field.label}" does not look like an email address` };
      return { ok: true, value: text };

    case "tel":
      if (!/^[+()\-.\s\d]{5,}$/.test(text))
        return { ok: false, error: `"${field.label}" does not look like a phone number` };
      return { ok: true, value: text };

    case "url": {
      const url = checkUrl(text);
      if (!url) return { ok: false, error: `"${field.label}" does not look like a web address` };
      return { ok: true, value: url };
    }

    case "regex":
      if (!matchesPattern(field.pattern ?? "", text))
        return {
          ok: false,
          error: field.patternMessage || `"${field.label}" is not in the expected format`,
        };
      return { ok: true, value: text };

    case "number":
    case "decimal":
    case "currency":
    case "slider":
    case "rating": {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `"${field.label}" must be a number` };

      if (field.type === "number" && !Number.isInteger(n))
        return { ok: false, error: `"${field.label}" must be a whole number` };

      // A rating's ceiling comes from its own column; every other numeric type
      // uses the shared min/max pair.
      const min = field.type === "rating" ? 0 : field.min;
      const max = field.type === "rating" ? (field.ratingMax ?? 5) : field.max;

      if (typeof min === "number" && Number.isFinite(min) && n < min)
        return { ok: false, error: `"${field.label}" must be ${min} or more` };
      if (typeof max === "number" && Number.isFinite(max) && n > max)
        return { ok: false, error: `"${field.label}" must be ${max} or less` };

      // Money is rounded rather than refused: a visitor typing 10.999 means ten
      // pounds ninety-nine, and rejecting it teaches them nothing.
      if (field.type === "currency") return { ok: true, value: Math.round(n * 100) / 100 };
      return { ok: true, value: n };
    }

    case "date":
    case "time":
    case "datetime": {
      if (field.type === "time") {
        if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text))
          return { ok: false, error: `"${field.label}" must be a time` };
        return { ok: true, value: text };
      }
      if (!withinDateBounds(text, field.minDate, field.maxDate))
        return { ok: false, error: `"${field.label}" is not a date this form accepts` };
      return { ok: true, value: text };
    }

    default:
      // Choice fields are checked against the offered options rather than
      // trusted: the select on the page is a suggestion, and the POST behind it
      // is not.
      if (CHOICE_TYPES.includes(field.type) && !field.options.includes(text))
        return { ok: false, error: `"${text}" is not one of the options for "${field.label}"` };
      return { ok: true, value: text };
  }
}

/**
 * A composite answer: one object holding the parts this form asked for.
 *
 * Required means every shown part is required — a half-filled name is not a
 * name. Parts the form does not show are never read from the payload, so a
 * caller cannot smuggle a `country` into a form that only asked for a city.
 */
function coerceComposite(field: FieldSpec, raw: unknown): AnswerResult {
  const parts = activeParts(field);
  const submitted = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;

  const value: Record<string, string> = {};
  let anyFilled = false;

  for (const part of parts) {
    const text = str(submitted[part.key], 200);
    if (text) anyFilled = true;
    value[part.key] = text;
  }

  if (field.required) {
    const missing = parts.find((p) => !value[p.key]);
    if (missing) return { ok: false, error: `"${field.label}" needs a ${missing.label.toLowerCase()}` };
  }

  return { ok: true, value: anyFilled ? value : {} };
}

/**
 * Flatten one answer for the CSV and the notification email.
 *
 * Composites become `first last` rather than `[object Object]`, and a boolean
 * becomes Yes/No. Deliberately lossy: these two outputs are read by a person,
 * where the stored object is what the API returns.
 */
export function flattenAnswer(field: FieldSpec, value: unknown): string {
  if (isCompositeType(field.type)) {
    if (!value || typeof value !== "object") return "";
    const parts = activeParts(field);
    return parts
      .map((p) => String((value as Record<string, unknown>)[p.key] ?? ""))
      .filter(Boolean)
      .join(field.type === "address" ? ", " : " ");
  }
  if (field.type === "checkbox" || field.type === "yesno" || field.type === "terms") {
    return value ? "Yes" : "No";
  }
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}
