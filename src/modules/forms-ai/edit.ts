import { cloudflareChat, cloudflareReady } from "../orbit/cloudflare-ai.js";
import {
  GENERATABLE_FIELD_TYPES,
  FONT_FAMILIES,
  CARD_SHADOWS,
  parseGeneratedTheme,
  type GeneratedTheme,
} from "./form-schema.js";
import { MAX_OPS, parseEditOps, type EditOp } from "./edit-ops.js";

/**
 * Change a form that already exists, without rewriting it.
 *
 * The generator answers "what should this form be"; this answers "what should
 * change about it". The difference is the whole point: an author editing a live
 * form has fields, wording and layout they did not ask about, and the surest
 * way to keep those is to produce an answer that cannot describe them.
 *
 * The model sees each field's id and is required to use them, so a reworded
 * label is an update to a known field rather than something that looks like a
 * removal and an addition. Everything it does not name is left alone by the
 * builder, which never re-serialises the form at all.
 */

const MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
];

const ATTEMPT_TIMEOUT_MS = 20_000;

/** How long a prompt may be. Past this it is a specification, not a request. */
export const MAX_EDIT_PROMPT_CHARS = 600;

function systemPrompt(): string {
  return [
    "You edit web forms. You reply with one JSON object and nothing else — no prose, no code fence, no explanation.",
    "",
    "You are given the form's current fields, each with an id. You reply with the changes to make, never with the form itself.",
    "",
    "Shape:",
    '{ "ops": [ … ] }',
    "",
    "Each operation is one of:",
    '{ "op": "updateField", "id": "<id>", "patch": { "label": string, "required": boolean, "placeholder": string, "helpText": string, "options": string[] } }',
    '{ "op": "removeField", "id": "<id>" }',
    '{ "op": "addField", "after": "<id>", "field": { "type": string, "label": string, "required": boolean, "placeholder": string, "options": string[] } }',
    '{ "op": "moveField", "id": "<id>", "after": "<id>" }',
    '{ "op": "setForm", "patch": { "title": string, "formDescription": string, "submitLabel": string } }',
    '{ "op": "setTheme", "patch": { "pageBg": string, "cardBg": string, "cardBorder": string, "accentColor": string, "labelColor": string, "inputBg": string, "inputBorder": string, "inputTextColor": string, "textMode": string, "fontFamily": string, "cardRadius": number, "cardShadow": string } }',
    "",
    "Rules:",
    `- At most ${MAX_OPS} operations. Emit only the changes the request actually asks for.`,
    '- Every "id" must be one of the ids you were given. Never invent one, and never use a label in place of an id.',
    '- A "patch" carries only the properties that change. Everything you leave out keeps its current value.',
    "- To reword a field, update it. Removing it and adding it back loses its settings and its answers.",
    `- A new field's "type" must be one of: ${GENERATABLE_FIELD_TYPES.join(", ")}.`,
    '- Fields you were given but do not mention are left exactly as they are. That is the normal case — do not list them.',
    '- Only emit "removeField" when the request explicitly asks to remove, delete, or drop that field. Never remove a field as a side effect of another change.',
    "",
    "Theme:",
    '- Colours are 6-digit hex strings like "#0f172a". Anything else is dropped.',
    '- Emit "setTheme" only when the request is about appearance. Send only the keys the request is actually about — a request about one colour should patch that one key, not the whole palette.',
    '- "textMode" is "light" on a dark card and "dark" on a light one.',
    `- "fontFamily" is one of: ${FONT_FAMILIES.join(", ")}.`,
    `- "cardShadow" is one of: ${CARD_SHADOWS.join(", ")}.`,
    "",
    "If the request changes nothing about the form, reply with an empty ops array.",
  ].join("\n");
}

const EXAMPLE_USER = [
  "Form: “Contact us”",
  "Fields:",
  '  f1  name      "Your name"        required',
  '  f2  email     "Email"            required',
  '  f3  text      "Company"          optional',
  '  f4  textarea  "Message"          required',
  "",
  "Change: make the email optional and add a phone number after it",
].join("\n");

const EXAMPLE_REPLY = JSON.stringify({
  ops: [
    { op: "updateField", id: "f2", patch: { required: false } },
    {
      op: "addField",
      after: "f2",
      field: { type: "phone", label: "Phone number", required: false },
    },
  ],
});

/** The first JSON object in a reply, brace-counted so nesting does not end it early. */
function extractJson(text: string): unknown {
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
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** One field as the model is shown it: an id, a type, a label, and whether it is required. */
export interface EditSnapshotField {
  id: string;
  type: string;
  label: string;
  required?: boolean;
  options?: string[];
}

export interface EditSnapshot {
  title?: string;
  formDescription?: string;
  submitLabel?: string;
  fields: EditSnapshotField[];
  theme?: Record<string, unknown>;
}

/**
 * The form written out for the model to read.
 *
 * A table rather than JSON: the ids have to be impossible to miss, and a model
 * reading its own output format back is more likely to answer with a form than
 * with operations on one.
 */
function describe(snapshot: EditSnapshot): string {
  const lines = [`Form: “${snapshot.title ?? "Untitled"}”`];
  if (snapshot.formDescription) lines.push(`Description: ${snapshot.formDescription}`);
  lines.push("Fields:");

  for (const f of snapshot.fields) {
    const parts = [`  ${f.id}`, f.type, `“${f.label}”`, f.required ? "required" : "optional"];
    if (f.options?.length) parts.push(`options: ${f.options.slice(0, 8).join(" | ")}`);
    lines.push(parts.join("  "));
  }

  if (!snapshot.fields.length) lines.push("  (none yet)");

  // Shown so a colour-only request ("make the button green") can patch just
  // that key with a value that still sits well against what is already
  // there, instead of guessing at a palette with no idea what it joins.
  const theme = snapshot.theme;
  if (theme && Object.keys(theme).length) {
    lines.push("Current theme:");
    lines.push(`  ${JSON.stringify(theme)}`);
  }

  return lines.join("\n");
}

export type EditResult =
  | { ok: true; ops: EditOp[]; model: string; summary: string }
  | { ok: false; status: number; error: string };

/**
 * A plain-language line for each op, built from the snapshot's own labels
 * rather than asked of the model — the ops are already the ground truth for
 * what changed, so a second model call to describe them would risk saying
 * something the ops themselves don't back up.
 */
function summarize(ops: EditOp[], labels: Map<string, string>): string {
  const parts = ops.map((op) => {
    switch (op.op) {
      case "removeField":
        return `removed “${labels.get(op.id) ?? op.id}”`;
      case "updateField": {
        const name = labels.get(op.id) ?? op.id;
        const changed = Object.keys(op.patch);
        if (changed.length === 1 && changed[0] === "required") {
          return `made “${name}” ${op.patch.required ? "required" : "optional"}`;
        }
        return `updated “${name}”`;
      }
      case "addField":
        return `added “${op.field.label}”`;
      case "moveField":
        return `reordered “${labels.get(op.id) ?? op.id}”`;
      case "setForm":
        return "updated the form details";
      case "setTheme":
        return "updated the theme";
      default:
        return "made a change";
    }
  });

  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function formsEditReady(): boolean {
  return cloudflareReady();
}

export async function generateEdit(
  prompt: string,
  snapshot: EditSnapshot,
): Promise<EditResult> {
  if (!cloudflareReady()) {
    return { ok: false, status: 503, error: "form editing is not configured" };
  }

  const asked = prompt.trim().slice(0, MAX_EDIT_PROMPT_CHARS);
  if (!asked) return { ok: false, status: 400, error: "prompt required" };

  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: EXAMPLE_USER },
    { role: "assistant", content: EXAMPLE_REPLY },
    { role: "user", content: `${describe(snapshot)}\n\nChange: ${asked}` },
  ];

  const knownIds = snapshot.fields.map((f) => f.id);
  const labels = new Map(snapshot.fields.map((f) => [f.id, f.label]));
  let lastDetail = "";

  for (const model of MODELS) {
    const res = await cloudflareChat({
      model,
      messages,
      // A list of changes is far smaller than a form. The cap is what stops a
      // model from "editing" by writing the whole thing out again.
      maxTokens: 1200,
      // Lower than the generator's: an edit has a right answer, and the variety
      // that makes a fresh palette interesting only makes an edit wrong.
      temperature: 0.2,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });

    if (!res.ok) {
      lastDetail = `${model}: ${res.detail}`;
      continue;
    }

    const json = extractJson(res.text);
    const parsed = parseEditOps(json, knownIds, { prompt: asked, labels });

    // The theme is read by its own parser, which applies the contrast
    // corrections that keep a generated palette legible. Parsed separately and
    // appended, so a reply that is only a restyle still produces an operation.
    const themeOp = readThemeOp(json, snapshot.theme as GeneratedTheme | undefined);

    if (parsed.ok) {
      const ops = themeOp ? [...parsed.ops, themeOp] : parsed.ops;
      return { ok: true, ops, model, summary: summarize(ops, labels) };
    }
    if (themeOp) return { ok: true, ops: [themeOp], model, summary: summarize([themeOp], labels) };

    lastDetail = `${model}: ${parsed.reason}`;
  }

  console.error("[forms-ai] edit failed —", lastDetail);
  return { ok: false, status: 502, error: "could not work out what to change" };
}

/** The `setTheme` operation in a reply, run through the theme parser. */
function readThemeOp(json: unknown, currentTheme?: GeneratedTheme): EditOp | null {
  if (!json || typeof json !== "object") return null;
  const ops = (json as Record<string, unknown>).ops;
  if (!Array.isArray(ops)) return null;

  const raw = ops.find(
    (o) => o && typeof o === "object" && (o as Record<string, unknown>).op === "setTheme",
  ) as Record<string, unknown> | undefined;
  if (!raw) return null;

  const parsed = parseGeneratedTheme({ theme: raw.patch }, currentTheme);
  return parsed.ok ? { op: "setTheme", patch: parsed.theme } : null;
}
