import { Form } from "./models/Form.js";
import { Submission } from "./models/Submission.js";
import { mailConfigured, sendOne } from "../../infra/mail/mailer.js";

/**
 * Validate raw submitted answers against a form's field schema.
 *
 * Every field is length-capped at its own `maxLength` regardless of what the
 * builder set as a soft limit — this is the hard ceiling. `select`/`radio`
 * values are checked against the field's own option list so a scripted post
 * can't write an arbitrary string into a field the UI would only ever offer a
 * fixed set of choices for.
 */
export function validateSubmissionData(
  fields: { key: string; type: string; required: boolean; options?: string[]; maxLength: number }[],
  raw: unknown,
): { data: Record<string, string> } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "form data is required" };
  const body = raw as Record<string, unknown>;
  const data: Record<string, string> = {};

  for (const field of fields) {
    const value = body[field.key];
    const asString = typeof value === "string" ? value.trim() : "";

    if (field.required && !asString) return { error: `"${field.label ?? field.key}" is required` };
    if (!asString) continue;

    if ((field.type === "select" || field.type === "radio") && field.options) {
      if (!field.options.includes(asString)) return { error: `"${field.key}" has an invalid value` };
    }

    if (field.type === "checkbox") {
      data[field.key] = asString === "true" || asString === "on" ? "true" : "false";
      continue;
    }

    data[field.key] = asString.slice(0, field.maxLength);
  }

  return { data };
}

/**
 * Per-form submission rate this hour, across all IPs.
 *
 * Per-IP limits alone fail against a distributed bot that rotates addresses.
 * This is the ceiling that actually holds against that — above it the form
 * flips into review mode: still accepting, every new row flagged, rather than
 * refusing outright and losing legitimate leads that happen to arrive during
 * an attack.
 */
const FORM_HOURLY_CEILING = 200;

export async function checkFormCeiling(formId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const count = await Submission.countDocuments({ formId, createdAt: { $gt: since } });
  if (count >= FORM_HOURLY_CEILING) {
    await Form.updateOne({ _id: formId }, { $set: { underReview: true } });
    return false;
  }
  return true;
}

/** Per-IP submissions to one form in the window, before this one is written. */
const PER_IP_LIMIT = 10;
const PER_IP_WINDOW_MS = 60 * 60 * 1000;

export async function checkIpRateLimit(formId: string, ipHash: string): Promise<boolean> {
  const since = new Date(Date.now() - PER_IP_WINDOW_MS);
  const count = await Submission.countDocuments({ formId, ipHash, createdAt: { $gt: since } });
  return count < PER_IP_LIMIT;
}

/** An exact repeat of the same answers to the same form inside this window is dropped silently. */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export async function isDuplicate(formId: string, dedupHash: string): Promise<boolean> {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await Submission.exists({ formId, dedupHash, createdAt: { $gt: since } });
  return Boolean(existing);
}

/**
 * Notification throttle — the one defense that actually protects the
 * product's own infrastructure. A hundred submissions must never mean a
 * hundred emails: that burns `mail-service`'s sending reputation, which is
 * shared with password resets and scheduled reports and is not quickly
 * repaired once damaged. Past this many in the window, later submissions in
 * the same hour are stored normally but do not trigger mail.
 */
const NOTIFY_HOURLY_LIMIT = 20;

export async function shouldNotify(formId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  // Submissions already written this hour, this call's own row included by the
  // caller writing before checking — an off-by-one toward "notify less" is the
  // safe direction here, unlike the ceilings above.
  const count = await Submission.countDocuments({ formId, createdAt: { $gt: since } });
  return count <= NOTIFY_HOURLY_LIMIT;
}

/**
 * Email the form's owner-configured addresses about a new submission.
 *
 * Fire-and-forget from the route's point of view: a mail outage must not turn
 * an accepted submission into an error response, since the row is already
 * safely stored by the time this runs.
 */
/**
 * Delete submissions past their form's configured retention window.
 *
 * Per-form, not a single global cutoff: `retentionDays` is null by default
 * (keep until deleted), and only a form the owner explicitly configured a
 * window for is swept. Runs against every form with a window set rather than
 * joining submissions to forms per-row, so the query stays one indexed scan
 * per form instead of a table scan of submissions.
 */
export async function sweepExpiredSubmissions(): Promise<{ formsSwept: number; deleted: number }> {
  const forms = await Form.find({ "settings.retentionDays": { $ne: null, $gt: 0 } }).select(
    "settings.retentionDays",
  );

  let deleted = 0;
  for (const form of forms) {
    const days = (form.get("settings") as { retentionDays: number }).retentionDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await Submission.deleteMany({ formId: form.id, createdAt: { $lt: cutoff } });
    deleted += result.deletedCount ?? 0;
  }

  return { formsSwept: forms.length, deleted };
}

export async function notifySubmission(
  form: InstanceType<typeof Form>,
  data: Record<string, string>,
): Promise<void> {
  if (!mailConfigured()) return;
  const emails = (form.get("settings") as { notifyEmails?: string[] } | undefined)?.notifyEmails ?? [];
  if (!emails.length) return;

  const lines = Object.entries(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const text = `New submission on "${form.get("name")}"\n\n${lines}`;

  await Promise.all(
    emails.map((email) =>
      sendOne({ email }, `New submission — ${form.get("name")}`, text).catch((e) =>
        console.error("[forms] notification failed:", (e as Error)?.message),
      ),
    ),
  );
}
