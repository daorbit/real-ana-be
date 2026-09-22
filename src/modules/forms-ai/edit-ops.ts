import {
  GENERATABLE_FIELD_TYPES,
  OPTION_FIELD_TYPES,
  type GeneratedField,
  type GeneratedTheme,
} from "./form-schema.js";


export const MAX_OPS = 20;

export interface RemoveFieldOp {
  op: "removeField";
  id: string;
}


export interface UpdateFieldOp {
  op: "updateField";
  id: string;
  patch: Partial<Omit<GeneratedField, "type">>;
}

export interface AddFieldOp {
  op: "addField";
  field: GeneratedField;
  /** Insert after this field, wherever it sits. Omitted means at the end. */
  after?: string;
}

export interface MoveFieldOp {
  op: "moveField";
  id: string;
  after?: string;
}

/** A change to the form itself rather than to any one field. */
export interface SetFormOp {
  op: "setForm";
  patch: { title?: string; formDescription?: string; submitLabel?: string };
}

export interface SetThemeOp {
  op: "setTheme";
  patch: GeneratedTheme;
}

export type EditOp =
  | RemoveFieldOp
  | UpdateFieldOp
  | AddFieldOp
  | MoveFieldOp
  | SetFormOp
  | SetThemeOp;

const TYPES = new Set<string>(GENERATABLE_FIELD_TYPES);

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


function readFieldPatch(raw: unknown): Partial<Omit<GeneratedField, "type">> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const patch: Partial<Omit<GeneratedField, "type">> = {};

  const label = text(r.label, 120);
  if (label) patch.label = label;

  if (typeof r.required === "boolean") patch.required = r.required;

  const placeholder = text(r.placeholder, 120);
  if (placeholder) patch.placeholder = placeholder;

  const helpText = text(r.helpText, 300);
  if (helpText) patch.helpText = helpText;

  const content = text(r.content, 2000);
  if (content) patch.content = content;

  const options = stringList(r.options, 40);
  if (options) patch.options = options;

  const rows = stringList(r.rows, 20);
  if (rows) patch.rows = rows;

  const maxRating = bounded(r.maxRating, 3, 10);
  if (maxRating !== undefined) patch.maxRating = maxRating;

  const min = bounded(r.min, -1_000_000, 1_000_000);
  if (min !== undefined) patch.min = min;

  const max = bounded(r.max, -1_000_000, 1_000_000);
  if (max !== undefined) patch.max = max;

  return patch;
}

/** A whole new field, or null when it could not be rendered. */
function readNewField(raw: unknown): GeneratedField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const type = typeof r.type === "string" ? r.type : "";
  if (!TYPES.has(type)) return null;

  const patch = readFieldPatch(raw);
  const label = patch.label ?? patch.content;
  if (!label) return null;

  const field: GeneratedField = {
    ...patch,
    type: type as GeneratedField["type"],
    label,
    required: patch.required === true,
  };

  // A choice field with no options renders as an empty control, which reads as
  // broken rather than unfinished.
  if (OPTION_FIELD_TYPES.has(type) && !field.options) {
    field.options = ["Option 1", "Option 2", "Option 3"];
  }
  if (type === "matrix" && !field.rows) field.rows = ["Row 1", "Row 2"];

  return field;
}


function readOp(raw: unknown, known: Set<string>): EditOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const op = typeof r.op === "string" ? r.op : "";
  const id = text(r.id, 100);
  const after = text(r.after, 100);

  switch (op) {
    case "removeField":
      return id && known.has(id) ? { op: "removeField", id } : null;

    case "updateField": {
      if (!id || !known.has(id)) return null;
      const patch = readFieldPatch(r.patch);
      // An update that changes nothing is not worth an undo step.
      return Object.keys(patch).length ? { op: "updateField", id, patch } : null;
    }

    case "addField": {
      const field = readNewField(r.field);
      if (!field) return null;
      return { op: "addField", field, ...(after && known.has(after) ? { after } : {}) };
    }

    case "moveField": {
      if (!id || !known.has(id)) return null;
      if (after && (!known.has(after) || after === id)) return null;
      return { op: "moveField", id, ...(after ? { after } : {}) };
    }

    case "setForm": {
      const p = (r.patch ?? {}) as Record<string, unknown>;
      const patch: SetFormOp["patch"] = {};
      const title = text(p.title, 120);
      if (title) patch.title = title;
      const formDescription = text(p.formDescription, 500);
      if (formDescription) patch.formDescription = formDescription;
      const submitLabel = text(p.submitLabel, 40);
      if (submitLabel) patch.submitLabel = submitLabel;
      return Object.keys(patch).length ? { op: "setForm", patch } : null;
    }

    default:
      return null;
  }
}

export type ParseOpsResult =
  | { ok: true; ops: EditOp[] }
  | { ok: false; reason: string };

/** Words worth matching against a prompt — short connective words match everything and prove nothing. */
function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * Whether the prompt plausibly names this field.
 *
 * A small model asked to change one field sometimes throws in an unrequested
 * `removeField` alongside the real op — a known failure mode of structured
 * JSON edits from 8B-class models. There is no way to ask the model "did you
 * mean to do that", so this is a cheap backstop: a removal only survives if
 * at least one non-trivial word from the field's own label shows up in what
 * the author actually typed.
 */
function promptNamesField(prompt: string, label: string | undefined): boolean {
  if (!label) return true;
  const labelWords = significantWords(label);
  if (!labelWords.length) return true;
  const promptWords = new Set(significantWords(prompt));
  return labelWords.some((w) => promptWords.has(w));
}

export function parseEditOps(
  raw: unknown,
  knownIds: Iterable<string>,
  /** The author's own request, and each known field's label — used to keep a
   * `removeField` the model was not actually asked for from going through. */
  guard?: { prompt: string; labels: Map<string, string> },
): ParseOpsResult {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).ops)
      ? ((raw as Record<string, unknown>).ops as unknown[])
      : null;

  if (!list) return { ok: false, reason: "no operations" };

  const known = new Set(knownIds);
  const ops = list
    .slice(0, MAX_OPS)
    .map((entry) => readOp(entry, known))
    .filter((entry): entry is EditOp => entry !== null)
    .filter((entry) => {
      if (!guard || entry.op !== "removeField") return true;
      return promptNamesField(guard.prompt, guard.labels.get(entry.id));
    });

  if (!ops.length) return { ok: false, reason: "no usable operations" };
  return { ok: true, ops };
}
