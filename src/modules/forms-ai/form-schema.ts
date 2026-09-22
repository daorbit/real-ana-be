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

export const OPTION_FIELD_TYPES = new Set<string>([
  "select",
  "radio",
  "checkbox",
  "multipleChoice",
  "ranking",
  "matrix",
]);

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

function readField(raw: unknown): GeneratedField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const type = typeof r.type === "string" ? r.type : "";
  if (!TYPES.has(type)) return null;

  const label = text(r.label, 120);

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

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function readable(
  color: string | undefined,
  background: string | undefined,
): string | undefined {
  if (!color || !background) return color;
  if (contrast(color, background) >= 4.5) return color;
  return luminance(background) > 0.4 ? "#1f2937" : "#f8fafc";
}

/**
 * `theme`, with `base` filled in wherever a key is missing — the palette a
 * partial patch would actually produce once merged onto what is live now.
 * Contrast only means something against that effective result: checking a
 * patch in isolation would wave through an `accentColor` that reads fine on
 * paper but disappears against a `cardBg` the request never touched.
 */
function withBase(theme: GeneratedTheme, base?: GeneratedTheme): GeneratedTheme {
  if (!base) return theme;
  return { ...base, ...theme };
}

function readTheme(raw: unknown, base?: GeneratedTheme): GeneratedTheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const theme: GeneratedTheme = {};

  for (const key of THEME_COLOR_KEYS) {
    const value = r[key];
    if (typeof value === "string" && HEX.test(value.trim())) {
      theme[key] = value.trim();
    }
  }

  if (
    typeof r.textMode === "string" &&
    (TEXT_MODES as readonly string[]).includes(r.textMode)
  ) {
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

  if (!Object.keys(theme).length) return undefined;

  // Corrections run against the effective (patch-over-base) palette, but only
  // the keys the patch itself set are written back — a partial edit should
  // still come back partial, not silently grow into a full restyle.
  const effective = withBase(theme, base);

  if ("labelColor" in theme || (!base && theme.labelColor === undefined)) {
    const corrected = readable(effective.labelColor, effective.cardBg);
    if (corrected !== undefined) theme.labelColor = corrected;
  }
  if ("inputTextColor" in theme || (!base && theme.inputTextColor === undefined)) {
    const corrected = readable(effective.inputTextColor, effective.inputBg);
    if (corrected !== undefined) theme.inputTextColor = corrected;
  }
  if ("accentColor" in theme && effective.cardBg) {
    theme.accentColor = readable(effective.accentColor, effective.cardBg);
  }
  if ("cardBg" in theme || "pageBg" in theme) {
    if (effective.cardBg && effective.pageBg && contrast(effective.cardBg, effective.pageBg) < 1.15) {
      // The card and the page it sits on are close enough to the same shade
      // that the card edge would be invisible. Nudge the card toward the
      // opposite end of the lightness scale rather than leaving it to blend in.
      theme.cardBg = luminance(effective.pageBg) > 0.4 ? "#1f2937" : "#ffffff";
    }
  }
  if (theme.cardBg) {
    theme.textMode = luminance(theme.cardBg) > 0.4 ? "dark" : "light";
  }

  return Object.keys(theme).length ? theme : undefined;
}

export type ParseResult =
  | { ok: true; form: GeneratedForm }
  | { ok: false; reason: string };

export type ParseThemeResult =
  | { ok: true; theme: GeneratedTheme }
  | { ok: false; reason: string };

export function parseGeneratedTheme(raw: unknown, base?: GeneratedTheme): ParseThemeResult {
  if (!raw || typeof raw !== "object")
    return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;

  const theme = readTheme(r.theme, base) ?? readTheme(r, base);

  if (!theme) return { ok: false, reason: "no usable theme" };

  const entries = Object.entries(theme).filter(([, v]) => v !== undefined);
  if (!entries.length) return { ok: false, reason: "no usable theme" };

  return { ok: true, theme: Object.fromEntries(entries) as GeneratedTheme };
}

export const MAX_FIELDS = 25;

export function parseGeneratedForm(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object")
    return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;

  const title = text(r.title, 120);
  if (!title) return { ok: false, reason: "no title" };

  const rawFields = Array.isArray(r.fields) ? r.fields : [];
  const fields = rawFields
    .slice(0, MAX_FIELDS)
    .map(readField)
    .filter((f): f is GeneratedField => f !== null);

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
