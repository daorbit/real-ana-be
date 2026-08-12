import { Form, CHOICE_TYPES, type FieldType } from "./models/Form.js";
import { Submission } from "./models/Submission.js";
import {
  checkRates,
  dedupHash,
  findRecentDuplicate,
  normaliseValue,
  verifyTimingToken,
} from "./antispam.js";
import { canAcceptSubmission, recordSubmissionUsage } from "../billing/quota.service.js";
import { notifySubmission } from "./notify.js";

/**
 * Turning a public POST into a stored lead.
 *
 * The ordering in `ingest` is deliberate and is the part to preserve: the cheap
 * local checks (honeypot, timing, shape) run before anything touches the
 * database, the rate limits run before the write, and the quota check runs
 * *last* and cannot refuse — it only decides whether the row is flagged and
 * whether anyone gets emailed.
 */

export type IngestContext = {
  ip: string;
  ipHash: string;
  userAgent: string;
  referrer: string;
  utm: { source: string; medium: string; campaign: string };
};

export type IngestResult =
  | { status: "ok"; submissionId: string; redirectUrl: string; successMessage: string }
  /** Accepted-looking, stored nothing. Bots and exact repeats both land here. */
  | { status: "swallowed" }
  | { status: "rejected"; code: 400 | 409 | 429 | 403; error: string };

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/**
 * Coerce and bound one answer against its field definition.
 *
 * Every value that reaches storage passes through here, so this is where the
 * length ceiling actually applies — the field's `maxLength` was already bounded
 * by `ABSOLUTE_MAX_FIELD_LENGTH` when the form was saved, which is what stops a
 * form owner from opening their own endpoint up to unbounded writes.
 */
function coerceAnswer(
  field: { key: string; label: string; type: FieldType; required: boolean; options: string[]; maxLength: number },
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (field.type === "checkbox") {
    const checked = raw === true || raw === "true" || raw === "on" || raw === "1";
    if (field.required && !checked) return { ok: false, error: `"${field.label}" is required` };
    return { ok: true, value: checked };
  }

  const text = str(raw, field.maxLength);

  if (!text) {
    if (field.required) return { ok: false, error: `"${field.label}" is required` };
    return { ok: true, value: "" };
  }

  if (field.type === "email" && !looksLikeEmail(text))
    return { ok: false, error: `"${field.label}" does not look like an email address` };

  if (field.type === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) return { ok: false, error: `"${field.label}" must be a number` };
    return { ok: true, value: n };
  }

  if (field.type === "tel" && !/^[+()\-.\s\d]{5,}$/.test(text))
    return { ok: false, error: `"${field.label}" does not look like a phone number` };

  // Choice fields are checked against the offered options rather than trusted:
  // the select on the page is a suggestion, and the POST behind it is not.
  if (CHOICE_TYPES.includes(field.type) && !field.options.includes(text))
    return { ok: false, error: `"${text}" is not one of the options for "${field.label}"` };

  return { ok: true, value: text };
}

export async function ingest(
  form: InstanceType<typeof Form>,
  body: Record<string, unknown>,
  context: IngestContext,
): Promise<IngestResult> {
  if (form.get("status") !== "published")
    return { status: "rejected", code: 403, error: "This form is not accepting responses." };

  // The honeypot, first and cheapest. Answered with the success shape on
  // purpose: telling a bot it was caught only teaches it to stop filling the
  // field, and then we lose the signal.
  if (str(body.website, 100) || str(body._gotcha, 100)) return { status: "swallowed" };

  const timing = verifyTimingToken(form.get("formKey") as string, body._t);
  if (timing === "too-fast") return { status: "swallowed" };
  if (timing === "expired")
    return {
      status: "rejected",
      code: 409,
      error: "This page has been open a while — refresh it and send again.",
    };
  if (timing !== "ok")
    return { status: "rejected", code: 400, error: "This form could not be verified. Refresh the page and try again." };

  const fields = ((form.get("fields") as Parameters<typeof coerceAnswer>[0][]) ?? []).filter(
    (f) => !(f as { hidden?: boolean }).hidden,
  );
  const submitted = (body.data ?? {}) as Record<string, unknown>;
  if (typeof submitted !== "object" || Array.isArray(submitted))
    return { status: "rejected", code: 400, error: "Malformed submission." };

  // Built from the form's own field list rather than from the payload, so
  // unknown keys a caller invents are dropped rather than stored — the shape of
  // a submission is the form's business, not the submitter's.
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const answer = coerceAnswer(field, submitted[field.key]);
    if (!answer.ok) return { status: "rejected", code: 400, error: answer.error };
    data[field.key] = answer.value;
  }

  const rates = await checkRates(form.id, context.ipHash);
  if (!rates.ok) return { status: "rejected", code: 429, error: rates.error };

  const hash = dedupHash(form.id, data);
  const duplicate = await findRecentDuplicate(form.id, hash);
  // An exact repeat is a double-click or a refreshed tab far more often than it
  // is an attack, so it gets the success screen and no second row.
  if (duplicate) return { status: "swallowed" };

  const settings = (form.get("settings") as Record<string, unknown>) ?? {};
  const dedupFieldKey = (settings.dedupFieldKey as string) ?? "";
  const dedupValue = dedupFieldKey ? normaliseValue(data[dedupFieldKey]) : "";

  if (dedupFieldKey && dedupValue) {
    const action = (settings.dedupAction as string) ?? "allow";
    if (action !== "allow") {
      const existing = await Submission.findOne({ formId: form.id, dedupValue }).sort({ createdAt: -1 });
      if (existing) {
        if (action === "reject")
          return {
            status: "rejected",
            code: 409,
            error: "We already have a response from you — thanks for getting in touch.",
          };
        // "replace": the newer answers win, and the row keeps its original
        // `createdAt` so the customer's first-contact date is not rewritten by
        // someone correcting a typo.
        await Submission.updateOne(
          { _id: existing._id },
          { $set: { data, dedupHash: hash, referrer: context.referrer, utm: context.utm } },
        );
        return {
          status: "ok",
          submissionId: String(existing._id),
          redirectUrl: (settings.redirectUrl as string) ?? "",
          successMessage: (settings.successMessage as string) ?? "",
        };
      }
    }
  }

  // Last, and never a refusal — see `canAcceptSubmission`. Over the line the
  // lead is still stored; what stops is the email.
  const quota = await canAcceptSubmission(String(form.get("workspaceId")));
  const overQuota = !quota.ok;

  const submission = await Submission.create({
    formId: form.id,
    workspaceId: form.get("workspaceId"),
    data,
    referrer: context.referrer,
    utm: context.utm,
    ipHash: context.ipHash,
    userAgent: context.userAgent,
    dedupHash: hash,
    dedupValue,
    overQuota,
    flagged: rates.flagged,
    flagReason: rates.flagged ? rates.reason : "",
  });

  await Form.updateOne(
    { _id: form.id },
    { $inc: { submissionCount: 1 }, $set: { lastSubmissionAt: new Date() } },
  );
  await recordSubmissionUsage(String(form.get("workspaceId")));

  // Awaited rather than fired and forgotten: a serverless function is frozen
  // the moment the response goes out, which would kill the send mid-flight.
  // `notifySubmission` swallows its own failures, so this cannot fail the
  // submission that has already been stored.
  await notifySubmission(form, String(submission._id), data, {
    overQuota,
    flagged: rates.flagged,
  });

  return {
    status: "ok",
    submissionId: String(submission._id),
    redirectUrl: (settings.redirectUrl as string) ?? "",
    successMessage: (settings.successMessage as string) ?? "",
  };
}

/**
 * The dashboard's view of one stored submission.
 *
 * `ipHash` is absent by construction, not stripped: it exists to rate-limit a
 * flood, not to be looked at, and the way to keep it that way is for no
 * presenter to name it.
 */
export function presentSubmission(submission: InstanceType<typeof Submission>) {
  return {
    id: submission.id,
    data: submission.get("data") ?? {},
    referrer: submission.get("referrer") ?? "",
    utm: submission.get("utm") ?? {},
    overQuota: Boolean(submission.get("overQuota")),
    flagged: Boolean(submission.get("flagged")),
    flagReason: submission.get("flagReason") ?? "",
    createdAt: submission.get("createdAt"),
  };
}

/**
 * Escape one cell for CSV.
 *
 * Two separate jobs in one function. The quoting is ordinary CSV correctness.
 * The leading apostrophe is not: submission data is attacker-controlled, Excel
 * and Sheets execute a cell beginning `=`, `+`, `-` or `@` on open, and
 * `=HYPERLINK(...)` in a downloaded leads export is a working phishing payload
 * aimed at the one person guaranteed to open the file.
 */
export function csvCell(value: unknown): string {
  let text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One CSV of every submission to a form, newest first. */
export async function buildCsv(form: InstanceType<typeof Form>): Promise<string> {
  const fields = ((form.get("fields") as { key: string; label: string }[]) ?? []).slice();
  const submissions = await Submission.find({ formId: form.id }).sort({ createdAt: -1 }).limit(50_000);

  const header = ["Submitted at", ...fields.map((f) => f.label), "Referrer", "UTM source", "UTM medium", "UTM campaign"];
  const rows = submissions.map((s) => {
    const data = (s.get("data") as Record<string, unknown>) ?? {};
    const utm = (s.get("utm") as Record<string, string>) ?? {};
    return [
      (s.get("createdAt") as Date)?.toISOString() ?? "",
      ...fields.map((f) => data[f.key]),
      s.get("referrer") ?? "",
      utm.source ?? "",
      utm.medium ?? "",
      utm.campaign ?? "",
    ];
  });

  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Delete submissions past each workspace's retention window.
 *
 * Opt-in per workspace and off by default (`submissionRetentionDays: 0`):
 * quietly destroying leads a customer believes they still have is worse than
 * keeping them too long, so the sweep only touches workspaces that asked for it.
 */
export async function sweepRetention(): Promise<{ workspaces: number; deleted: number }> {
  const { Workspace } = await import("../workspace/models/Workspace.js");
  const workspaces = await Workspace.find({ submissionRetentionDays: { $gt: 0 } }).select(
    "submissionRetentionDays",
  );

  let deleted = 0;
  for (const ws of workspaces) {
    const days = (ws.get("submissionRetentionDays") as number) ?? 0;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await Submission.deleteMany({ workspaceId: ws.id, createdAt: { $lt: cutoff } });
    deleted += result.deletedCount ?? 0;
  }

  return { workspaces: workspaces.length, deleted };
}
