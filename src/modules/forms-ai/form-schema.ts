
export const GENERATABLE_FIELD_TYPES = [
  "name",
  "email",
  "phone",
  "address",
  "website",
  "text",
  "textarea",
  "number",
  "decimal",
  "currency",
  "select",
  "radio",
  "checkbox",
  "multipleChoice",
  "country",
  "ranking",
  "date",
  "time",
  "datetime",
  "monthYear",
  "file",
  "imageUpload",
  "rating",
  "slider",
  "terms",
  "decisionBox",
  "yesNo",
  "signature",
  "matrix",
  "heading",
  "description",
] as const;

export type GeneratableFieldType = (typeof GENERATABLE_FIELD_TYPES)[number];

/** Types whose `options` list is the field — one with none renders empty. */
export const OPTION_FIELD_TYPES = new Set<string>([
  "select",
  "radio",
  "checkbox",
  "multipleChoice",
  "ranking",
  "matrix",
]);

/** Theme keys the generator may set, each a hex colour unless noted. */
export const THEME_COLOR_KEYS = [
  "pageBg",
  "cardBg",
  "cardBorder",
  "accentColor",
  "labelColor",
  "inputBg",
  "inputBorder",
  "inputTextColor",
] as const;

export const FONT_FAMILIES = ["inter", "system", "serif", "mono"] as const;
export const CARD_SHADOWS = ["none", "sm", "md", "lg", "xl"] as const;
export const TEXT_MODES = ["auto", "light", "dark"] as const;

export interface GeneratedField {
  type: GeneratableFieldType;
  label: string;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[];
  rows?: string[];
  content?: string;
  maxRating?: number;
  min?: number;
  max?: number;
}

export interface GeneratedTheme {
  pageBg?: string;
  cardBg?: string;
  cardBorder?: string;
  accentColor?: string;
  labelColor?: string;
  inputBg?: string;
  inputBorder?: string;
  inputTextColor?: string;
  textMode?: (typeof TEXT_MODES)[number];
  fontFamily?: (typeof FONT_FAMILIES)[number];
  cardRadius?: number;
  cardShadow?: (typeof CARD_SHADOWS)[number];
}

export interface GeneratedForm {
  title: string;
  formDescription?: string;
  submitLabel?: string;
  fields: GeneratedField[];
  theme?: GeneratedTheme;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Trimmed to a sane length, or undefined when there is nothing worth keeping. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => text(v, 120))
    .filter((v): v is string => Boolean(v))
    .slice(0, max);
  return out.length ? out : undefined;
}

function bounded(value: unknown, lo: number, hi: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

const TYPES = new Set<string>(GENERATABLE_FIELD_TYPES);

/**
 * One field, or null when it cannot be rendered.
 *
 * Dropping a bad field rather than failing the form is deliberate: nine good
 * fields and one missing is something the editor fixes in a moment, where a
 * refusal leaves the person with nothing and no idea which part offended.
 */
function readField(raw: unknown): GeneratedField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const type = typeof r.type === "string" ? r.type : "";
  if (!TYPES.has(type)) return null;

  const label = text(r.label, 120);
  // Headings and descriptions carry their text in `content`; everything else is
  // unusable without a label, since that is what the respondent reads.
  const content = text(r.content, 2000);
  if (!label && !content) return null;

  const field: GeneratedField = {
    type: type as GeneratableFieldType,
    label: label ?? content ?? "",
    required: r.required === true,
  };

  const placeholder = text(r.placeholder, 120);
  if (placeholder) field.placeholder = placeholder;

  const helpText = text(r.helpText, 300);
  if (helpText) field.helpText = helpText;

  if (content) field.content = content;

  const options = stringList(r.options, 40);
  if (options) field.options = options;

  // A choice field with no options renders as an empty control, which reads as
  // a broken form rather than an unfinished one. Give it something to show.
  if (OPTION_FIELD_TYPES.has(type) && !field.options) {
    field.options = ["Option 1", "Option 2", "Option 3"];
  }

  if (type === "matrix") {
    const rows = stringList(r.rows, 20);
    field.rows = rows ?? ["Row 1", "Row 2"];
  }

  const maxRating = bounded(r.maxRating, 3, 10);
  if (type === "rating" && maxRating) field.maxRating = maxRating;

  if (type === "slider" || type === "number" || type === "decimal") {
    const min = bounded(r.min, -1_000_000, 1_000_000);
    const max = bounded(r.max, -1_000_000, 1_000_000);
    if (min !== undefined) field.min = min;
    if (max !== undefined && (min === undefined || max > min)) field.max = max;
  }

  return field;
}

/** Relative luminance, for deciding whether text on a background is readable. */
function luminance(hex: string): number {
  const channel = (h: string) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(hex.slice(1, 3));
  const g = channel(hex.slice(3, 5));
  const b = channel(hex.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, 1 (identical) to 21. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Text that would be unreadable on its own background, replaced.
 *
 * The models pick a palette by mood and regularly land on white labels over a
 * pale card — it looks deliberate in the JSON and is invisible on the page. The
 * form is a draft the person edits, but a draft they cannot read is not one
 * they can edit, so this is corrected rather than left for them to notice.
 *
 * 4.5:1 is the WCAG AA threshold for body text. Below it, the colour is swapped
 * for near-black or near-white against the same background, whichever passes.
 */
function readable(color: string | undefined, background: string | undefined): string | undefined {
  if (!color || !background) return color;
  if (contrast(color, background) >= 4.5) return color;
  return luminance(background) > 0.4 ? "#1f2937" : "#f8fafc";
}

/** Only the theme keys we know, only where the value is actually usable. */
function readTheme(raw: unknown): GeneratedTheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const theme: GeneratedTheme = {};

  for (const key of THEME_COLOR_KEYS) {
    const value = r[key];
    if (typeof value === "string" && HEX.test(value.trim())) {
      theme[key] = value.trim();
    }
  }

  if (typeof r.textMode === "string" && (TEXT_MODES as readonly string[]).includes(r.textMode)) {
    theme.textMode = r.textMode as GeneratedTheme["textMode"];
  }
  if (
    typeof r.fontFamily === "string" &&
    (FONT_FAMILIES as readonly string[]).includes(r.fontFamily)
  ) {
    theme.fontFamily = r.fontFamily as GeneratedTheme["fontFamily"];
  }
  if (
    typeof r.cardShadow === "string" &&
    (CARD_SHADOWS as readonly string[]).includes(r.cardShadow)
  ) {
    theme.cardShadow = r.cardShadow as GeneratedTheme["cardShadow"];
  }

  const radius = bounded(r.cardRadius, 0, 40);
  if (radius !== undefined) theme.cardRadius = radius;

  // Text sits on the card; the input's own text sits on the input.
  theme.labelColor = readable(theme.labelColor, theme.cardBg);
  theme.inputTextColor = readable(theme.inputTextColor, theme.inputBg);

  // `textMode` decides which way the renderer's own text goes, so a card that
  // is light with "light" text — or the reverse — undoes the colours above.
  if (theme.cardBg) {
    theme.textMode = luminance(theme.cardBg) > 0.4 ? "dark" : "light";
  }

  return Object.keys(theme).length ? theme : undefined;
}

export type ParseResult =
  | { ok: true; form: GeneratedForm }
  | { ok: false; reason: string };

/** How many fields one generated form may carry. */
export const MAX_FIELDS = 25;

/**
 * Read the model's answer into a form, or say why it cannot be.
 *
 * Everything is checked rather than cast: this is the boundary between a
 * language model's output and a document the editor will render, and the whole
 * point of it is that nothing past here has to wonder whether `type` is real.
 */
export function parseGeneratedForm(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;

  const title = text(r.title, 120);
  if (!title) return { ok: false, reason: "no title" };

  const rawFields = Array.isArray(r.fields) ? r.fields : [];
  const fields = rawFields
    .slice(0, MAX_FIELDS)
    .map(readField)
    .filter((f): f is GeneratedField => f !== null);

  // A form with no usable field is not a starting point, it is an empty canvas
  // the person could have opened themselves — better to say the generation
  // failed than to hand back nothing and call it a result.
  if (!fields.length) return { ok: false, reason: "no usable fields" };

  const form: GeneratedForm = { title, fields };

  const description = text(r.formDescription, 500);
  if (description) form.formDescription = description;

  const submitLabel = text(r.submitLabel, 40);
  if (submitLabel) form.submitLabel = submitLabel;

  const theme = readTheme(r.theme);
  if (theme) form.theme = theme;

  return { ok: true, form };
}
