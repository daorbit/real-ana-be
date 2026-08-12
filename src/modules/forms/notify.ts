import { Submission } from "./models/Submission.js";
import { Form } from "./models/Form.js";
import { mailConfigured, sendOne, broadcastHtml } from "../../infra/mail/mailer.js";

/**
 * Telling a form's owner that someone filled it in.
 *
 * The throttle here is the single measure that protects *us* rather than the
 * customer. A hundred submissions must never mean a hundred emails: that burns
 * `mail-service`'s sending reputation, which is shared with password resets and
 * scheduled reports and is not quickly repaired. Above the cap the notification
 * becomes a digest — the owner still learns there is something to look at, and
 * one message says it.
 */

/** Notification emails one form may send per window before it switches to a digest. */
export const NOTIFY_LIMIT = 10;
export const NOTIFY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The answers as plain text, one `Label: value` per line.
 *
 * Deliberately only plain text. Submission data is attacker-controlled input
 * from an unauthenticated endpoint, and the safest thing to do with it in an
 * email is never to build HTML from it at all — `broadcastHtml` escapes
 * whatever it is handed and turns blank lines into paragraphs, so passing this
 * string through it renders correctly *and* cannot carry markup into the form
 * owner's inbox.
 */
function renderAnswers(
  fields: { key: string; label: string }[],
  data: Record<string, unknown>,
): string {
  return fields
    .filter((f) => data[f.key] !== undefined && data[f.key] !== "")
    .map((f) => {
      const value = Array.isArray(data[f.key])
        ? (data[f.key] as unknown[]).join(", ")
        : String(data[f.key] ?? "");
      return `${f.label}: ${value}`;
    })
    .join("\n");
}

/** How many notifications this form has already sent inside the window. */
async function sentRecently(formId: string): Promise<number> {
  return Submission.countDocuments({
    formId,
    notifiedAt: { $gt: new Date(Date.now() - NOTIFY_WINDOW_MS) },
  });
}

/**
 * Notify a form's watchers about one submission.
 *
 * Never throws and never blocks the response: the row is already stored, and a
 * mail outage must not read to the person who filled the form as a failure they
 * should repeat. Returns quietly when there is nothing to do — no addresses, no
 * mail transport, or a submission that arrived over quota.
 */
export async function notifySubmission(
  form: InstanceType<typeof Form>,
  submissionId: string,
  data: Record<string, unknown>,
  options: { overQuota: boolean; flagged: boolean },
): Promise<void> {
  const settings = (form.get("settings") as Record<string, unknown>) ?? {};
  const recipients = (settings.notifyEmails as string[]) ?? [];
  if (!recipients.length || !mailConfigured()) return;

  // The soft-quota bargain, held up on this line: the lead was captured, and
  // the notification is what stops. Same for a flagged row — a form in review
  // mode is probably being hit by a bot, and mailing every hit is how the bot
  // gets to use our sender reputation.
  if (options.overQuota || options.flagged) return;

  const formName = form.get("name") as string;
  const alreadySent = await sentRecently(form.id);

  try {
    if (alreadySent >= NOTIFY_LIMIT) {
      // One digest per window, not one per submission over the line — the
      // marker is the `notifiedAt` on the row that crossed it.
      if (alreadySent > NOTIFY_LIMIT) return;

      const text = `"${formName}" has received more than ${NOTIFY_LIMIT} submissions in the last hour.

Individual notifications are paused for this form until the rate settles, so you don't get a mailbox full of them. Every submission is still being captured — open the form in Quantalog to read them.`;

      for (const email of recipients)
        await sendOne({ email }, `${formName}: submissions paused for the hour`, text, broadcastHtml(text));
    } else {
      const fields = (form.get("fields") as { key: string; label: string }[]) ?? [];
      // Blank line between the opening line and the answers: `broadcastHtml`
      // splits on it, so the answers land as their own paragraph.
      const text = `New submission on "${formName}".\n\n${renderAnswers(fields, data)}`;

      for (const email of recipients)
        await sendOne({ email }, `New submission: ${formName}`, text, broadcastHtml(text));
    }

    await Submission.updateOne({ _id: submissionId }, { $set: { notifiedAt: new Date() } });
  } catch (e) {
    // Logged, not surfaced. The submitter has already been told their details
    // were received, which is true — the row is stored either way.
    console.error("[forms] notification failed:", (e as Error)?.message);
  }
}
