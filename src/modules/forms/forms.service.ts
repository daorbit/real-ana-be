import {
  Form,
  CHOICE_TYPES,
  COMPOSITE_PARTS,
  FIELD_TYPES,
  MAX_FIELDS_PER_FORM,
  MAX_OPTIONS_PER_FIELD,
  MAX_UPLOAD_MB,
  ABSOLUTE_MAX_FIELD_LENGTH,
  UPLOAD_TYPES,
  isCompositeType,
  isInputType,
  slugifyFieldKey,
  type FieldType,
} from "./models/Form.js";
import { Submission } from "./models/Submission.js";

/**
 * Form CRUD and the rules a form definition has to satisfy.
 *
 * The one rule worth reading twice is field-key immutability. Answers are
 * stored as `{ [fieldKey]: value }`, so a key that changes orphans every
 * historical answer under it — silently, and only visible later when a
 * submissions table has a column of blanks where a customer's leads used to be.
 * Enforced here rather than in the builder, because the builder is a client and
 * clients can be replaced by curl.
 */

export type Denied = { ok: false; error: string };
export type Ok<T> = { ok: true; value: T };
export type Result<T> = Ok<T> | Denied;

export type FieldInput = {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  help?: unknown;
  placeholder?: unknown;
  required?: unknown;
  options?: unknown;
  maxLength?: unknown;
  hidden?: unknown;
  width?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
  currency?: unknown;
  ratingMax?: unknown;
  pattern?: unknown;
  patternMessage?: unknown;
  minDate?: unknown;
  maxDate?: unknown;
  maxFileMb?: unknown;
  acceptedTypes?: unknown;
  parts?: unknown;
  content?: unknown;
  level?: unknown;
};

/** Row widths a field may take, in twelfths: a third, a half, or the full row. */
export const FIELD_WIDTHS = [4, 6, 12] as const;

export type CleanField = {
  key: string;
  label: string;
  type: FieldType;
  help: string;
  placeholder: string;
  required: boolean;
  options: string[];
  maxLength: number;
  order: number;
  hidden: boolean;
  width: number;
  min: number | null;
  max: number | null;
  step: number | null;
  currency: string;
  ratingMax: number;
  pattern: string;
  patternMessage: string;
  minDate: string;
  maxDate: string;
  maxFileMb: number;
  acceptedTypes: string[];
  parts: string[];
  content: string;
  level: number;
};

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Validate a submitted field list into the shape the schema stores.
 *
 * `existingKeys` is every key the form already has; when the form has
 * submissions, a field whose key is not in that set is a new field (fine) but a
 * key that has *disappeared* from the input is a deletion (not fine — see
 * `applyFieldEdit`).
 */
export function cleanFields(input: unknown): Result<CleanField[]> {
  if (!Array.isArray(input)) return { ok: false, error: "fields must be an array" };
  if (!input.length) return { ok: false, error: "a form needs at least one field" };
  if (input.length > MAX_FIELDS_PER_FORM)
    return { ok: false, error: `a form holds up to ${MAX_FIELDS_PER_FORM} fields` };

  const fields: CleanField[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of (input as FieldInput[]).entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, error: `field ${index + 1} is not an object` };

    const label = str(raw.label, 200);
    if (!label) return { ok: false, error: `field ${index + 1} needs a label` };

    const type = str(raw.type, 20) as FieldType;
    if (!FIELD_TYPES.includes(type))
      return { ok: false, error: `field "${label}" has an unknown type "${type}"` };

    // A key sent by the client wins, so an edit round-trip preserves it. Only a
    // field that has never had one gets a generated key.
    const key = str(raw.key, 60) || slugifyFieldKey(label);
    if (!/^[a-z][a-z0-9_]*$/.test(key))
      return {
        ok: false,
        error: `field "${label}" has an invalid key — keys are lowercase letters, digits and underscores`,
      };
    if (seen.has(key))
      return { ok: false, error: `two fields share the key "${key}" — labels must be distinguishable` };
    seen.add(key);

    let options: string[] = [];
    if (CHOICE_TYPES.includes(type)) {
      const rawOptions = Array.isArray(raw.options) ? raw.options : [];
      options = rawOptions.map((o) => str(o, 200)).filter(Boolean);
      if (!options.length) return { ok: false, error: `field "${label}" needs at least one option` };
      if (options.length > MAX_OPTIONS_PER_FIELD)
        return { ok: false, error: `field "${label}" has more than ${MAX_OPTIONS_PER_FIELD} options` };
    }

    // The builder's cap, bounded by ours. A form owner may shorten an answer;
    // they may not lengthen it past what the unauthenticated endpoint accepts.
    const requested = Number(raw.maxLength);
    const maxLength = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), ABSOLUTE_MAX_FIELD_LENGTH)
      : type === "textarea"
        ? 2_000
        : 500;

    // A pattern is written by the owner and matched against a stranger's input,
    // so it is compiled once here: an invalid regex must fail at save time, in
    // front of the person who can fix it, rather than silently at ingest.
    const pattern = str(raw.pattern, 200);
    if (type === "regex" && pattern) {
      try {
        new RegExp(pattern);
      } catch {
        return { ok: false, error: `the pattern on "${label}" is not a valid regular expression` };
      }
    }

    const parts = Array.isArray(raw.parts)
      ? (raw.parts as unknown[]).map((p) => str(p, 20)).filter(Boolean)
      : [];
    if (isCompositeType(type) && parts.length) {
      const known = (COMPOSITE_PARTS[type] ?? []).map((p) => p.key);
      const unknown = parts.find((p) => !known.includes(p));
      if (unknown) return { ok: false, error: `"${label}" has no part called "${unknown}"` };
    }

    fields.push({
      key,
      label,
      type,
      help: str(raw.help, 300),
      placeholder: str(raw.placeholder, 200),
      // Layout elements collect nothing, so "required" is meaningless on one
      // and would make a form unsubmittable if it were ever honoured.
      required: isInputType(type) ? Boolean(raw.required) : false,
      options,
      maxLength,
      order: index,
      hidden: Boolean(raw.hidden),
      // Anything unrecognised falls back to full width. A layout value that
      // does not divide a row cleanly would render as a gap, and a gap the
      // builder cannot explain reads as a bug rather than a choice.
      width: (FIELD_WIDTHS as readonly number[]).includes(Number(raw.width)) ? Number(raw.width) : 12,
      min: numberOrNull(raw.min),
      max: numberOrNull(raw.max),
      step: numberOrNull(raw.step),
      currency: str(raw.currency, 3).toUpperCase(),
      ratingMax: clamp(Number(raw.ratingMax), 2, 10, 5),
      pattern,
      patternMessage: str(raw.patternMessage, 200),
      minDate: str(raw.minDate, 40),
      maxDate: str(raw.maxDate, 40),
      // Bounded here as well as in the schema: this is the number the public
      // upload endpoint checks a file against, so it cannot be whatever the
      // builder sent.
      maxFileMb: clamp(Number(raw.maxFileMb), 1, MAX_UPLOAD_MB, 5),
      acceptedTypes: Array.isArray(raw.acceptedTypes)
        ? (raw.acceptedTypes as unknown[]).map((t) => str(t, 40)).filter(Boolean).slice(0, 20)
        : [],
      parts,
      content: str(raw.content, 2_000),
      level: [1, 2, 3].includes(Number(raw.level)) ? Number(raw.level) : 2,
    });
  }

  // Checked after the loop rather than inside it: a form may legitimately hold
  // only layout elements while it is being built, and refusing that would mean
  // a heading cannot be the first thing you drop onto a blank canvas.
  if (!fields.some((f) => isInputType(f.type)))
    return { ok: false, error: "a form needs at least one field that collects an answer" };

  return { ok: true, value: fields };
}

function numberOrNull(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Reconcile a proposed field list against a form that already has submissions.
 *
 * Once answers exist, three edits are refused outright — changing a key,
 * changing a field's type, and dropping a field. The first two silently
 * reinterpret stored data; the third makes it unreachable. Dropping is instead
 * translated into hiding: the field stops rendering and stops being accepted,
 * and the submissions table keeps the column.
 *
 * Below the first submission none of this applies and the list is taken as
 * given — a form being drafted should be freely editable.
 */
export function applyFieldEdit(
  existing: CleanField[],
  proposed: CleanField[],
  hasSubmissions: boolean,
): Result<CleanField[]> {
  if (!hasSubmissions) return { ok: true, value: proposed };

  const existingByKey = new Map(existing.map((f) => [f.key, f]));
  const proposedByKey = new Map(proposed.map((f) => [f.key, f]));

  for (const field of proposed) {
    const before = existingByKey.get(field.key);
    if (!before) continue; // A genuinely new field. Adding is always safe.
    if (before.type !== field.type)
      return {
        ok: false,
        error: `"${before.label}" already has answers stored as ${before.type} — its type cannot change. Add a new field instead.`,
      };
  }

  // Anything the client left out is a removal. Kept, hidden, and pushed to the
  // end so it does not sit in the middle of the live form's order.
  const retired = existing
    .filter((f) => !proposedByKey.has(f.key))
    .map((f, i) => ({ ...f, hidden: true, order: proposed.length + i }));

  return { ok: true, value: [...proposed, ...retired] };
}

/** Whether this form has ever been submitted. Cheap — reads the denormalised counter. */
export async function hasSubmissions(form: InstanceType<typeof Form>): Promise<boolean> {
  if ((form.get("submissionCount") as number) > 0) return true;
  // The counter is authoritative in practice, but a row written before it
  // existed (or by a failed partial write) must not read as "safe to rename".
  const one = await Submission.findOne({ formId: form.id }).select("_id");
  return Boolean(one);
}

/** Validate the settings blob. Everything is optional; anything absent keeps its stored value. */
export function cleanSettings(input: unknown, fields: CleanField[]): Result<Record<string, unknown>> {
  if (input === undefined) return { ok: true, value: {} };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "settings must be an object" };

  const raw = input as Record<string, unknown>;
  const settings: Record<string, unknown> = {};

  if (raw.submitText !== undefined) settings.submitText = str(raw.submitText, 40) || "Submit";
  if (raw.successMessage !== undefined) settings.successMessage = str(raw.successMessage, 500);
  if (raw.closedMessage !== undefined) settings.closedMessage = str(raw.closedMessage, 500);
  if (raw.logoUrl !== undefined) settings.logoUrl = str(raw.logoUrl, 500);
  if (raw.primaryColor !== undefined) settings.primaryColor = str(raw.primaryColor, 20);
  if (raw.captchaEnabled !== undefined) settings.captchaEnabled = Boolean(raw.captchaEnabled);

  if (raw.redirectUrl !== undefined) {
    const url = str(raw.redirectUrl, 500);
    if (url) {
      // Scheme-checked because this URL is handed to a visitor's browser after
      // they submit. `javascript:` there would be our page executing someone
      // else's script on our domain.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: "the redirect URL is not a valid URL" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return { ok: false, error: "the redirect URL must start with http:// or https://" };
    }
    settings.redirectUrl = url;
  }

  if (raw.notifyEmails !== undefined) {
    const list = Array.isArray(raw.notifyEmails) ? raw.notifyEmails : [];
    const emails = list.map((e) => str(e, 200).toLowerCase()).filter(Boolean);
    for (const email of emails)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
        return { ok: false, error: `"${email}" does not look like an email address` };
    if (emails.length > 10)
      return { ok: false, error: "a form notifies up to 10 addresses" };
    settings.notifyEmails = [...new Set(emails)];
  }

  if (raw.dedupFieldKey !== undefined) {
    const key = str(raw.dedupFieldKey, 60);
    if (key && !fields.some((f) => f.key === key))
      return { ok: false, error: `"${key}" is not a field on this form` };
    settings.dedupFieldKey = key;
  }

  if (raw.dedupAction !== undefined) {
    const action = str(raw.dedupAction, 20);
    if (!["allow", "replace", "reject"].includes(action))
      return { ok: false, error: "dedupAction must be allow, replace or reject" };
    settings.dedupAction = action;
  }

  return { ok: true, value: settings };
}

/**
 * The authed representation of a form.
 *
 * Built by naming every field rather than spreading the document, so a column
 * added to the schema later does not appear in an API response nobody decided
 * to put it in.
 */
export function presentForm(form: InstanceType<typeof Form>) {
  return {
    id: form.id,
    workspaceId: String(form.get("workspaceId")),
    siteId: form.get("siteId") ? String(form.get("siteId")) : null,
    name: form.get("name"),
    formKey: form.get("formKey"),
    status: form.get("status"),
    fields: form.get("fields"),
    settings: form.get("settings"),
    submissionCount: form.get("submissionCount") ?? 0,
    lastSubmissionAt: form.get("lastSubmissionAt") ?? null,
    createdAt: form.get("createdAt"),
    updatedAt: form.get("updatedAt"),
  };
}

/**
 * What the hosted page is allowed to see.
 *
 * A whitelist, not a delete-list. Projecting by naming the safe fields means a
 * field added to the schema next year is invisible here by default; stripping
 * the unsafe ones instead means it is *published* by default, and the person
 * adding it never thinks about this file.
 */
export function presentPublicForm(form: InstanceType<typeof Form>, showBranding: boolean) {
  const settings = form.get("settings") as Record<string, unknown>;
  const fields = (form.get("fields") as CleanField[]) ?? [];

  return {
    formKey: form.get("formKey"),
    name: form.get("name"),
    status: form.get("status"),
    // Hidden fields are retired, not rendered — but their answers still exist,
    // which is why they are filtered here rather than deleted from the form.
    fields: fields
      .filter((f) => !f.hidden)
      .sort((a, b) => a.order - b.order)
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        help: f.help,
        placeholder: f.placeholder,
        required: f.required,
        options: f.options,
        maxLength: f.maxLength,
        // A textarea in a third of a row is unusable whatever the builder said,
        // so the render-time floor is here rather than trusted from storage.
        width: f.type === "textarea" ? 12 : (f.width ?? 12),
        // Everything the hosted page needs to render and pre-validate this
        // field. Client-side validation is a courtesy — `validate-answer.ts`
        // re-checks all of it, and that is the copy that decides.
        min: f.min ?? null,
        max: f.max ?? null,
        step: f.step ?? null,
        currency: f.currency ?? "",
        ratingMax: f.ratingMax ?? 5,
        pattern: f.pattern ?? "",
        patternMessage: f.patternMessage ?? "",
        minDate: f.minDate ?? "",
        maxDate: f.maxDate ?? "",
        maxFileMb: f.maxFileMb ?? 5,
        acceptedTypes: f.acceptedTypes ?? [],
        parts: f.parts ?? [],
        content: f.content ?? "",
        level: f.level ?? 2,
      })),
    settings: {
      submitText: settings?.submitText ?? "Submit",
      successMessage: settings?.successMessage ?? "",
      closedMessage: settings?.closedMessage ?? "",
      logoUrl: settings?.logoUrl ?? "",
      primaryColor: settings?.primaryColor ?? "",
      captchaEnabled: Boolean(settings?.captchaEnabled),
    },
    // Resolved server-side from the plan, not read from the form: a client that
    // could turn this off would be a client that could remove our branding.
    showBranding,
  };
}
