import mongoose, { Schema } from "mongoose";
import { nanoid } from "nanoid";

/**
 * A lead/contact form built inside a workspace and published at a hosted URL.
 *
 * Workspace-level, not site-level: a workspace with no `Site` and no tracker
 * installed can still build and publish forms. `siteId` is optional and exists
 * only so a submission can later be joined to `Event` for attribution.
 *
 * `formKey` is the public identity — the hosted page is `/f/<formKey>` and the
 * public API is keyed on it, so the Mongo `_id` never leaves the authed
 * surface. Same convention as `Site.siteId` and `ApiKey`'s `sk_live_` prefix:
 * the prefix means a glance at a log line says what kind of id it is.
 */

/**
 * Field types that store one scalar answer.
 *
 * Grouped by how the value is validated rather than by how it is rendered — a
 * `url` and a `regex` field look identical on the page and are checked
 * completely differently, which is the distinction that matters here.
 */
export const SCALAR_FIELD_TYPES = [
  "text",
  "email",
  "tel",
  "textarea",
  "url",
  "regex",
  "select",
  "checkbox",
  "radio",
  "number",
  "decimal",
  "currency",
  "date",
  "time",
  "datetime",
  "rating",
  "slider",
  "yesno",
  "terms",
  "file",
  "image",
] as const;

/**
 * Field types whose answer is several named parts.
 *
 * Stored as an object under one key — `data.full_name = { first, last }` —
 * rather than as several sibling fields, because the parts belong together:
 * asking for a name is one question, and splitting it into two independent
 * fields means a CSV where nothing ties the halves back to one person.
 */
export const COMPOSITE_FIELD_TYPES = ["name", "address"] as const;

/**
 * Elements that render but collect nothing.
 *
 * They carry a key like any other element so ordering, selection and editing
 * work unchanged, but the key is never used to store an answer — a heading has
 * nothing to say when the form is submitted. `isInputType` below is what every
 * ingest, CSV and dedup path uses to tell the two apart.
 */
export const LAYOUT_FIELD_TYPES = [
  "heading",
  "description",
  "divider",
  "spacer",
  "section",
  "pagebreak",
] as const;

export const FIELD_TYPES = [
  ...SCALAR_FIELD_TYPES,
  ...COMPOSITE_FIELD_TYPES,
  ...LAYOUT_FIELD_TYPES,
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types whose answer is chosen from `options` rather than typed. */
export const CHOICE_TYPES: FieldType[] = ["select", "radio"];

/** Types that upload a file and store its URL. Plan-gated and off by default. */
export const UPLOAD_TYPES: FieldType[] = ["file", "image"];

/** Whether a field of this type contributes an answer to `Submission.data`. */
export function isInputType(type: FieldType): boolean {
  return !(LAYOUT_FIELD_TYPES as readonly string[]).includes(type);
}

export function isCompositeType(type: FieldType): boolean {
  return (COMPOSITE_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * The parts of each composite type, in the order they render.
 *
 * Fixed rather than configurable: these exist so the common questions have one
 * shape across every form, which is what makes a submission from one form
 * comparable to a submission from another. A form needing a different breakdown
 * builds it from ordinary fields.
 */
export const COMPOSITE_PARTS: Record<string, { key: string; label: string; width: number }[]> = {
  name: [
    { key: "first", label: "First", width: 6 },
    { key: "last", label: "Last", width: 6 },
  ],
  address: [
    { key: "line1", label: "Address line 1", width: 12 },
    { key: "line2", label: "Address line 2", width: 12 },
    { key: "city", label: "City", width: 6 },
    { key: "state", label: "State / Region", width: 6 },
    { key: "postal", label: "Postal code", width: 6 },
    { key: "country", label: "Country", width: 6 },
  ],
};

export const FORM_STATUSES = ["draft", "published", "closed"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/**
 * Hard ceiling on any single answer, whatever the builder set.
 *
 * The per-field `maxLength` is the form owner's preference; this is ours. The
 * submit endpoint is unauthenticated, so the length a stranger may write has to
 * be bounded by something they cannot edit.
 */
export const ABSOLUTE_MAX_FIELD_LENGTH = 5_000;

/** Fields one form may hold. Not a plan limit — a guard on document size. */
export const MAX_FIELDS_PER_FORM = 50;

/** Choices one select/radio field may offer. */
export const MAX_OPTIONS_PER_FIELD = 50;

/**
 * The largest file the public upload endpoint will accept, whatever a form's
 * own `maxFileMb` says.
 *
 * Ours, not the owner's. Uploads arrive from an unauthenticated endpoint and
 * land in storage we pay for, so the ceiling has to be one a form owner cannot
 * raise.
 */
export const MAX_UPLOAD_MB = 25;

const fieldSchema = new Schema(
  {
    /**
     * The stable machine key answers are stored under.
     *
     * Immutable once the form has submissions, and enforced server-side rather
     * than trusted from the builder: renaming a key orphans every stored
     * `data[key]`, and the row it orphans is a lead somebody paid to acquire.
     */
    key: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: FIELD_TYPES, required: true },
    /** Shown under the input. Not validated against — purely guidance. */
    help: { type: String, trim: true, maxlength: 300, default: "" },
    placeholder: { type: String, trim: true, maxlength: 200, default: "" },
    required: { type: Boolean, default: false },
    /** select/radio only. Ignored for every other type. */
    options: { type: [String], default: [] },
    maxLength: { type: Number, default: 500, min: 1, max: ABSOLUTE_MAX_FIELD_LENGTH },
    order: { type: Number, default: 0 },
    /**
     * How much of a row this field occupies, in twelfths.
     *
     * Layout as a property of the field rather than a `rows[]` wrapper around
     * groups of them. Both render the same 1-, 2- and 3-column result, but a
     * flat list keeps `fields[]` the single ordered thing that reordering,
     * key-immutability, and the CSV columns all read — a nested structure would
     * mean every one of those grows a traversal for a purely visual concern.
     *
     * Rows are implicit: consecutive fields pack left-to-right until they would
     * exceed twelve, then wrap. A full-width field therefore always starts a new
     * row without needing to say so.
     */
    width: { type: Number, enum: [4, 6, 12], default: 12 },
    /**
     * A field retired after the form had submissions.
     *
     * Deleting it outright would leave stored answers under a key nothing
     * describes, so removal from the builder becomes hiding: the field stops
     * rendering and stops being accepted, and the submissions table keeps the
     * column.
     */
    hidden: { type: Boolean, default: false },

    /**
     * Numeric bounds, for the types where a range is the validation.
     *
     * Shared across number/decimal/currency/rating/slider rather than a field
     * per type: they differ in how they are rendered and in nothing else, and
     * five near-identical pairs of columns would drift apart.
     */
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    /** Slider granularity, and the decimal places a decimal/currency answer keeps. */
    step: { type: Number, default: null },
    /** Currency fields only. ISO 4217, shown beside the input. */
    currency: { type: String, trim: true, maxlength: 3, default: "" },
    /** Rating fields only: how many stars are offered. */
    ratingMax: { type: Number, default: 5, min: 2, max: 10 },

    /**
     * The pattern a `regex` field must match.
     *
     * Stored as a string and compiled per submission, with a length cap and a
     * timeout at the call site: a pattern is written by the form's owner but
     * matched against a stranger's input, which is where catastrophic
     * backtracking turns a validation rule into an outage.
     */
    pattern: { type: String, trim: true, maxlength: 200, default: "" },
    /** Shown when `pattern` fails, since a regex is not an error message. */
    patternMessage: { type: String, trim: true, maxlength: 200, default: "" },

    /**
     * Date/time bounds, as ISO strings.
     *
     * Strings rather than Dates: "no date before today" is a rule that has to
     * survive being stored, and a Date pinned at save time would mean a form
     * built in March still refusing April next year.
     */
    minDate: { type: String, trim: true, maxlength: 40, default: "" },
    maxDate: { type: String, trim: true, maxlength: 40, default: "" },

    /** Upload fields: what may be sent, and how large. Bounded again server-side. */
    maxFileMb: { type: Number, default: 5, min: 1, max: 25 },
    acceptedTypes: { type: [String], default: [] },

    /**
     * Which parts of a composite field are shown.
     *
     * Address line 2 and country are noise on a form that only needs a city, so
     * the parts are opt-out. Empty means every part, which is what an existing
     * field written before this column existed should do.
     */
    parts: { type: [String], default: [] },

    /** Layout elements: the text they render. Never stored as an answer. */
    content: { type: String, trim: true, maxlength: 2_000, default: "" },
    /** Heading level, for `heading` elements. */
    level: { type: Number, enum: [1, 2, 3], default: 2 },
  },
  { _id: false },
);

const settingsSchema = new Schema(
  {
    submitText: { type: String, trim: true, maxlength: 40, default: "Submit" },
    successMessage: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "Thanks — we've got your details and will be in touch.",
    },
    /** Overrides `successMessage` when set. Validated as http(s) on write. */
    redirectUrl: { type: String, trim: true, maxlength: 500, default: "" },
    /** Where a new submission is announced. Throttled — see `notify.ts`. */
    notifyEmails: { type: [String], default: [] },
    /**
     * The field whose value identifies a person, usually the email.
     *
     * Set, a repeat value is treated as the same person rather than a second
     * lead; unset, only an exact repeat of the whole payload is deduplicated.
     */
    dedupFieldKey: { type: String, trim: true, maxlength: 60, default: "" },
    /**
     * What a repeat of `dedupFieldKey` does: keep both rows, replace the
     * previous one, or refuse the second. Default keeps both, because a form
     * owner who has not thought about it would rather have a duplicate to
     * delete than a lead that was never stored.
     */
    dedupAction: { type: String, enum: ["allow", "replace", "reject"], default: "allow" },
    /**
     * Off by default and never flipped on for the owner.
     *
     * A lead form's entire job is conversion and a captcha costs conversions,
     * so it is the last resort the owner reaches for once they actually see
     * spam — not the first defence. The honeypot, timing token, and rate limits
     * carry the normal case.
     */
    captchaEnabled: { type: Boolean, default: false },
    logoUrl: { type: String, trim: true, maxlength: 500, default: "" },
    primaryColor: { type: String, trim: true, maxlength: 20, default: "" },
    closedMessage: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "This form is no longer accepting responses.",
    },
  },
  { _id: false },
);

const formSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    /** Attribution only — a form does not need a site to exist or to publish. */
    siteId: { type: Schema.Types.ObjectId, ref: "Site", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    formKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => `frm_${nanoid(12)}`,
    },
    status: { type: String, enum: FORM_STATUSES, default: "draft", index: true },
    fields: { type: [fieldSchema], default: [] },
    settings: { type: settingsSchema, default: () => ({}) },

    /**
     * Denormalised counters, incremented on ingest.
     *
     * The list page shows a count per form, and counting `Submission` rows for
     * every form on every page load is a query per row. `lastSubmissionAt` is
     * here for the same reason — "quiet for three weeks" is the useful column.
     */
    submissionCount: { type: Number, default: 0 },
    lastSubmissionAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The list page's only query: this workspace's forms, newest first. */
formSchema.index({ workspaceId: 1, createdAt: -1 });

export const Form = mongoose.model("Form", formSchema);

/**
 * A machine key derived from a label: lowercase, underscores, no leading digit.
 *
 * Generated once when a field is added and then left alone. Regenerating it on
 * every label edit is exactly the bug field-key immutability exists to prevent.
 */
export function slugifyFieldKey(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!base) return "field";
  // Mongo permits it, but a key starting with a digit is awkward in every
  // template language that will render this, so shift it.
  return /^[0-9]/.test(base) ? `f_${base}` : base;
}
