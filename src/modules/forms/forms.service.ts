import { Form, FIELD_TYPES, type FieldType } from "./models/Form.js";
import { Submission } from "./models/Submission.js";

/**
 * Field-schema helpers shared by the authed CRUD route and, later, the
 * builder's client-side validation mirror.
 */

/** Slugify a label into a stable machine key: lowercase, ascii, underscored. */
function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "field"
  );
}

/**
 * A key for a new field, unique within the form.
 *
 * Generated once from the label and then left alone — see the immutability
 * note on `Field.key` in the model. A collision (two fields both labelled
 * "Email") gets a numeric suffix rather than silently overwriting data under
 * the first field's key.
 */
export function generateFieldKey(label: string, existingKeys: Set<string>): string {
  const base = slugify(label);
  if (!existingKeys.has(base)) return base;

  let n = 2;
  while (existingKeys.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export type IncomingField = {
  key?: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  maxLength?: number;
  pageBreakAfter?: boolean;
};

export type ThemePreset = {
  slug: string;
  name: string;
  primaryColor: string;
  backgroundColor: string;
  fontFamily: string;
};

/**
 * Fixed set of visual presets the theme gallery offers — "pick one of these,"
 * not a theme editor. Colocated with `FIELD_TYPES`'s home rather than a
 * separate module: both are the fixed vocabulary the builder offers, and
 * splitting a one-export catalog into its own file buys nothing. Adding a
 * preset later is a data change here, not a schema or endpoint change.
 */
export const PRESET_THEMES: ThemePreset[] = [
  { slug: "default", name: "Default", primaryColor: "#10b981", backgroundColor: "#ffffff", fontFamily: "sans-serif" },
  { slug: "midnight", name: "Midnight", primaryColor: "#818cf8", backgroundColor: "#0f172a", fontFamily: "sans-serif" },
  { slug: "sunrise", name: "Sunrise", primaryColor: "#f97316", backgroundColor: "#fff7ed", fontFamily: "sans-serif" },
  { slug: "ocean", name: "Ocean", primaryColor: "#0ea5e9", backgroundColor: "#f0f9ff", fontFamily: "sans-serif" },
  { slug: "rose", name: "Rose", primaryColor: "#e11d48", backgroundColor: "#fff1f2", fontFamily: "sans-serif" },
  { slug: "forest", name: "Forest", primaryColor: "#15803d", backgroundColor: "#f0fdf4", fontFamily: "sans-serif" },
  { slug: "slate", name: "Slate", primaryColor: "#475569", backgroundColor: "#f8fafc", fontFamily: "sans-serif" },
  { slug: "grape", name: "Grape", primaryColor: "#9333ea", backgroundColor: "#faf5ff", fontFamily: "sans-serif" },
];

export function getThemePreset(slug: unknown): ThemePreset {
  return PRESET_THEMES.find((t) => t.slug === slug) ?? PRESET_THEMES[0];
}

/**
 * Validate and normalise a field list from the client into the shape the
 * `Form` schema expects, assigning `order` from array position and generating
 * any key that is missing (a brand-new field the builder hasn't keyed yet).
 *
 * Returns `{ error }` rather than throwing — every caller is a route that
 * wants a 400, not a 500, for a malformed field list.
 */
export function normalizeFields(
  raw: unknown,
): { fields: IncomingField[] & { order: number }[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "fields must be a list" };
  if (raw.length === 0) return { error: "a form needs at least one field" };
  if (raw.length > 40) return { error: "a form may have up to 40 fields" };

  const seenKeys = new Set<string>();
  const fields = [];

  for (const [i, f] of raw.entries()) {
    const label = String((f as IncomingField)?.label ?? "").trim().slice(0, 120);
    if (!label) return { error: `field ${i + 1} needs a label` };

    const type = (f as IncomingField)?.type;
    if (!FIELD_TYPES.includes(type as FieldType)) return { error: `field ${i + 1} has an unknown type` };

    const requestedKey = String((f as IncomingField)?.key ?? "").trim();
    const key = requestedKey || generateFieldKey(label, seenKeys);
    if (seenKeys.has(key)) return { error: `duplicate field key "${key}"` };
    seenKeys.add(key);

    const options =
      type === "select" || type === "radio"
        ? (Array.isArray((f as IncomingField)?.options) ? (f as IncomingField).options! : [])
            .map((o) => String(o).trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 50)
        : undefined;

    if ((type === "select" || type === "radio") && (!options || options.length === 0)) {
      return { error: `field "${label}" needs at least one option` };
    }

    fields.push({
      key,
      label,
      type,
      required: Boolean((f as IncomingField)?.required),
      options,
      maxLength: Math.min(Math.max(Number((f as IncomingField)?.maxLength) || 500, 1), 5000),
      order: i,
      pageBreakAfter: Boolean((f as IncomingField)?.pageBreakAfter),
    });
  }

  return { fields: fields as IncomingField[] & { order: number }[] };
}

/**
 * Field keys that may not be removed or renamed because submissions already
 * carry data under them. The builder must warn before doing either; this is
 * the server-side enforcement behind that warning.
 */
export async function lockedFieldKeys(formId: string): Promise<Set<string>> {
  const hasAny = await Submission.exists({ formId });
  if (!hasAny) return new Set();

  const form = await Form.findById(formId).select("fields");
  return new Set((form?.get("fields") as { key: string }[] | undefined)?.map((f) => f.key) ?? []);
}

/**
 * Reject a field-list update that drops or renames a key locked by existing
 * submissions. Adding new fields, reordering, or editing a label without
 * touching `key` is always allowed.
 */
export function violatesFieldLock(
  nextFields: { key: string }[],
  locked: Set<string>,
): string | null {
  if (locked.size === 0) return null;
  const nextKeys = new Set(nextFields.map((f) => f.key));
  for (const key of locked) {
    if (!nextKeys.has(key)) {
      return `the field "${key}" has existing submissions and cannot be removed — hide it instead`;
    }
  }
  return null;
}
