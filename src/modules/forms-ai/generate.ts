import { cloudflareChat, cloudflareReady } from "../orbit/cloudflare-ai.js";
import {
  GENERATABLE_FIELD_TYPES,
  OPTION_FIELD_TYPES,
  FONT_FAMILIES,
  CARD_SHADOWS,
  MAX_FIELDS,
  parseGeneratedForm,
  type GeneratedForm,
} from "./form-schema.js";
import { reconcileRevision } from "./reconcile.js";

/**
 * Turn a sentence into a starting-point form.
 *
 * Cloudflare Workers AI only, by choice rather than by fallback: this runs
 * while someone watches a modal, and the OpenRouter models measured 17-31s on
 * comparable work where these answer in one to three. A generation nobody waits
 * for is a generation nobody uses.
 *
 * The result is a draft the editor opens, never a form that goes live on its
 * own. That is what makes an imperfect answer acceptable — the person is one
 * click from fixing it, and the alternative they had was an empty canvas.
 */

/**
 * Tried in order, biggest first.
 *
 * The 70B writes better labels and picks more coherent palettes; the 8B is the
 * safety net for when Cloudflare is busy, and is fast enough that falling back
 * to it is barely visible. Both are prompted identically — neither supports
 * constrained decoding on this endpoint, so the parser is what guarantees the
 * shape either way.
 */
const MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
];

/** Per-attempt budget. Two attempts still have to fit inside a request. */
const ATTEMPT_TIMEOUT_MS = 20_000;

const OPTION_TYPES = [...OPTION_FIELD_TYPES].join(", ");

/**
 * The instructions, built from the same lists the parser enforces.
 *
 * Written out rather than kept as a constant string so the two can never
 * disagree: a field type removed from the allow-list disappears from the prompt
 * in the same edit, instead of being asked for and then silently dropped.
 */
function systemPrompt(): string {
  return [
    "You design web forms. You reply with one JSON object and nothing else — no prose, no code fence, no explanation.",
    "",
    "Shape:",
    "{",
    '  "title": string,',
    '  "formDescription": string,',
    '  "submitLabel": string,',
    '  "fields": [ { "type": string, "label": string, "required": boolean, "placeholder": string, "helpText": string, "options": string[], "rows": string[], "content": string, "maxRating": number, "min": number, "max": number } ],',
    '  "theme": { "pageBg": string, "cardBg": string, "cardBorder": string, "accentColor": string, "labelColor": string, "inputBg": string, "inputBorder": string, "inputTextColor": string, "textMode": string, "fontFamily": string, "cardRadius": number, "cardShadow": string }',
    "}",
    "",
    `"type" must be one of: ${GENERATABLE_FIELD_TYPES.join(", ")}.`,
    "Any other type is rejected and the field is thrown away.",
    "",
    "Rules:",
    `- At most ${MAX_FIELDS} fields. Ask for what is actually needed and stop — a short form is completed, a long one is abandoned.`,
    `- These types need a non-empty "options" array: ${OPTION_TYPES}.`,
    '- "matrix" also needs "rows": the statements being rated, with "options" as the answer columns.',
    '- "heading" and "description" carry their text in "content" and are layout, not questions.',
    '- Mark a field required only when the form is useless without it.',
    '- "name", "email", "phone", "address", "country", "date", "rating", "signature" already know what they collect. Use them rather than a "text" field named after them.',
    "",
    "Theme:",
    "- Every colour is a 6-digit hex string like \"#0f172a\". Anything else is dropped.",
    "- Pick one coherent palette that suits the subject, not a set of unrelated colours. A medical intake form is calm and light; a party RSVP can be bold.",
    '- "textMode" is "light" on a dark card and "dark" on a light one — this is what keeps the text readable, so match it to "cardBg".',
    `- "fontFamily" is one of: ${FONT_FAMILIES.join(", ")}.`,
    `- "cardShadow" is one of: ${CARD_SHADOWS.join(", ")}.`,
    '- "cardRadius" is a number of pixels, 0 to 40.',
  ].join("\n");
}

/**
 * A worked example, so the model has the shape in front of it.
 *
 * One example rather than several: these are small models on a latency budget,
 * and a long prompt costs more time than the extra examples buy in quality.
 */
const EXAMPLE_USER = "a contact form for a design studio";
const EXAMPLE_REPLY = JSON.stringify({
  title: "Contact us",
  formDescription: "Tell us what you need and we'll come back within one business day.",
  submitLabel: "Send message",
  fields: [
    { type: "name", label: "Full name", required: true, placeholder: "Ada Lovelace" },
    { type: "email", label: "Email", required: true, placeholder: "ada@example.com" },
    {
      type: "select",
      label: "What is this about?",
      required: true,
      options: ["General enquiry", "New project", "Careers", "Something else"],
    },
    { type: "textarea", label: "Message", required: true, placeholder: "How can we help?" },
    { type: "decisionBox", label: "Send me occasional updates" },
  ],
  theme: {
    pageBg: "#f8fafc",
    cardBg: "#ffffff",
    cardBorder: "#e2e8f0",
    accentColor: "#0f172a",
    labelColor: "#0f172a",
    inputBg: "#ffffff",
    inputBorder: "#cbd5e1",
    inputTextColor: "#0f172a",
    textMode: "dark",
    fontFamily: "inter",
    cardRadius: 14,
    cardShadow: "lg",
  },
});

/**
 * The first JSON object in a reply.
 *
 * These models are asked for bare JSON and usually give it, but they also wrap
 * it in a code fence or open with a sentence often enough that failing on it
 * would waste a working generation. Braces are counted rather than regexed so a
 * nested object does not end the match early.
 */
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

export type GenerateResult =
  | { ok: true; form: GeneratedForm; model: string }
  | { ok: false; status: number; error: string };

export function formsAiReady(): boolean {
  return cloudflareReady();
}

/** How long a prompt may be. Past this it is a specification, not a request. */
export const MAX_PROMPT_CHARS = 600;

export async function generateForm(
  prompt: string,
  /**
   * The form being revised, when this is a follow-up.
   *
   * Sent back as the assistant's own previous answer rather than described in
   * the prompt: the model is then editing something it "said", which is what
   * keeps "add a phone field" from rewriting the other nine.
   */
  previous?: GeneratedForm,
): Promise<GenerateResult> {
  if (!cloudflareReady()) {
    return { ok: false, status: 503, error: "form generation is not configured" };
  }

  const asked = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (!asked) return { ok: false, status: 400, error: "prompt required" };

  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: EXAMPLE_USER },
    { role: "assistant", content: EXAMPLE_REPLY },
    ...(previous
      ? [
          { role: "user", content: "Here is the form so far." },
          { role: "assistant", content: JSON.stringify(previous) },
          {
            role: "user",
            content:
              `Change it: ${asked}\n\n` +
              "Reply with the whole form again as one JSON object, not just the change.\n" +
              "Every field that is already there must still be there, in the same order, with the same wording — unless this request is explicitly about that field. Do not drop fields.\n" +
              "Leave \"theme\" exactly as it is unless the request is about colours, fonts or styling.",
          },
        ]
      : [{ role: "user", content: asked }]),
  ];

  let lastDetail = "";

  for (const model of MODELS) {
    const res = await cloudflareChat({
      model,
      messages,
      maxTokens: 2400,
      // Low, not zero: the palette is the one place a little variation reads as
      // design rather than noise, and the parser bounds everything else.
      temperature: 0.4,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });

    if (!res.ok) {
      lastDetail = `${model}: ${res.detail}`;
      continue;
    }

    const parsed = parseGeneratedForm(extractJson(res.text));
    if (parsed.ok) {
      // On a revision, pull the answer back toward the form it was editing —
      // the small models drop fields and restyle without being asked, both
      // silently. A first generation has nothing to reconcile against.
      const form = previous
        ? reconcileRevision(previous, parsed.form, asked)
        : parsed.form;
      return { ok: true, form, model };
    }

    // A model that answered but not usably. Worth trying the next one: the
    // failure is usually a truncated object rather than a refusal.
    lastDetail = `${model}: ${parsed.reason}`;
  }

  console.error("[forms-ai] generation failed —", lastDetail);
  return { ok: false, status: 502, error: "could not generate a form from that prompt" };
}
