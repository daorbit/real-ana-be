import mongoose, { Schema } from "mongoose";
import { nanoid } from "nanoid";

/**
 * A lead-capture form: a workspace-defined schema, hosted at a public URL.
 *
 * Workspace-level, not site-level — a workspace with no `Site` and no tracker
 * installed can still build and publish forms. `siteId` is optional and exists
 * only for attribution, never as a requirement to create a form.
 */

export const FORM_STATUSES = ["draft", "published", "closed"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FIELD_TYPES = [
  "text",
  "email",
  "tel",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "number",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const fieldSchema = new Schema(
  {
    /**
     * Stable machine key, generated from the label at creation time.
     *
     * Immutable once the form has submissions — enforced in the route, not
     * here, because the check needs a `Submission.exists` query the schema
     * cannot run. Renaming a key after that point would orphan every stored
     * `data[key]` already written under the old one.
     */
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: FIELD_TYPES, required: true },
    required: { type: Boolean, default: false },
    /** select/radio only. Ignored for every other type. */
    options: { type: [String], default: undefined },
    maxLength: { type: Number, default: 500 },
    order: { type: Number, required: true },
    /**
     * Ends a page at this field. Page structure is derived from field order
     * rather than a separate `pages[]` array, so it can never drift out of
     * sync with a field being reordered or deleted — the same reasoning that
     * makes `order` a plain index instead of its own list.
     */
    pageBreakAfter: { type: Boolean, default: false },
  },
  { _id: false }
);

const formSettingsSchema = new Schema(
  {
    submitText: { type: String, default: "Submit", maxlength: 40 },
    successMessage: { type: String, default: "Thanks — we got it.", maxlength: 300 },
    /** Overrides `successMessage` when set. */
    redirectUrl: { type: String, maxlength: 500 },
    notifyEmails: { type: [String], default: [] },
    /** Field key used to dedupe repeat submissions. Usually the email field. */
    dedupFieldKey: { type: String },
    captchaEnabled: { type: Boolean, default: false },
    logoUrl: { type: String, maxlength: 500 },
    primaryColor: { type: String, maxlength: 20 },
    /**
     * Preset slug from `PRESET_THEMES` in `forms.service.ts`. `primaryColor`/
     * `logoUrl` above still apply as per-form overrides layered on top of
     * whichever preset is chosen, so a form that set a color before the
     * gallery existed keeps it rather than losing it to a default theme.
     */
    theme: { type: String, default: "default", maxlength: 40 },
    themeOverrides: {
      primaryColor: { type: String, maxlength: 20 },
      backgroundColor: { type: String, maxlength: 20 },
      fontFamily: { type: String, maxlength: 80 },
    },
    closedMessage: { type: String, default: "This form is no longer accepting responses.", maxlength: 300 },
    /**
     * Days to keep a submission before the retention sweep deletes it. `null`
     * means keep until the owner deletes it by hand — the default, so an
     * existing or newly created form never starts silently losing leads
     * because a sweep started running.
     */
    retentionDays: { type: Number, default: null },
  },
  { _id: false }
);

const formSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    /** Attribution only — never required to create or publish a form. */
    siteId: { type: Schema.Types.ObjectId, ref: "Site" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /**
     * Public key, same convention as `Site.siteId` and `ApiKey`'s
     * `sk_live_${nanoid(32)}`. The Mongo `_id` stays internal — putting it in a
     * public URL would publish an id that has no reason to be guessable.
     */
    formKey: { type: String, required: true, unique: true, default: () => `frm_${nanoid(12)}`, index: true },
    status: { type: String, enum: FORM_STATUSES, default: "draft" },
    fields: { type: [fieldSchema], default: [] },
    settings: { type: formSettingsSchema, default: () => ({}) },
    /**
     * Set once the form has been flagged for review by the anti-abuse ceiling
     * in `submissions.service.ts`. The dashboard surfaces this; it does not
     * stop new submissions.
     */
    underReview: { type: Boolean, default: false },
  },
  { timestamps: true }
);

formSchema.index({ workspaceId: 1, status: 1 });

export const Form = mongoose.model("Form", formSchema);
