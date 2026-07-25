/**
 * Outbound email, over Gmail's SMTP.
 *
 * There is no transactional mail provider on this project, so sending goes
 * straight through a Gmail account with an app password. That shapes everything
 * here: Gmail caps a free account at roughly 500 recipients a day and throttles
 * bursts, so messages go out one at a time with a small gap rather than in a
 * single fan-out, and the caller gets a per-recipient result instead of one
 * all-or-nothing verdict.
 *
 * The transport is created once and reused. Nodemailer keeps the connection
 * pooled, which matters when a send goes to a few dozen addresses — a fresh TLS
 * handshake per message is what gets an account rate-limited.
 */

import nodemailer, { type Transporter } from "nodemailer";

/** Gap between messages. Slow enough that Gmail doesn't read a batch as a burst. */
const SEND_GAP_MS = 400;

let transporter: Transporter | null = null;

/** Whether credentials are configured at all. Routes check this before sending. */
export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** The address recipients see. Falls back to the login account. */
export function mailFrom(): string {
  const address = process.env.SMTP_FROM || process.env.SMTP_USER || "";
  const name = process.env.SMTP_FROM_NAME || "Quantalog";
  return address ? `"${name}" <${address}>` : "";
}

/**
 * The shared transport, built on first use.
 *
 * `pool` keeps a single authenticated connection alive across a batch, and
 * `maxMessages` lets nodemailer recycle it before Gmail decides one connection
 * has served too many — a reconnect mid-batch is cheaper than a refusal.
 */
function getTransport(): Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 465,
    // 465 is implicit TLS; 587 upgrades with STARTTLS instead.
    secure: (Number(process.env.SMTP_PORT) || 465) === 465,
    auth: {
      user: process.env.SMTP_USER as string,
      // Gmail rejects the account password when 2FA is on — this is an app
      // password, generated per-application in the Google account settings.
      pass: process.env.SMTP_PASS as string,
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  });

  return transporter;
}

/** Confirm the credentials actually authenticate, without sending anything. */
export async function verifyMail(): Promise<void> {
  await getTransport().verify();
}

export type Recipient = { email: string; name?: string };

export type SendResult = {
  email: string;
  ok: boolean;
  /** Present only on failure — the SMTP or transport error, trimmed. */
  error?: string;
};

/**
 * Send one message to each recipient, sequentially.
 *
 * Each address gets its own message rather than one message with many
 * recipients: it keeps addresses from leaking to each other, and it lets
 * `{{name}}` differ per person. One failure doesn't stop the rest — a single
 * bad address in a list of forty shouldn't cost the other thirty-nine their
 * mail — so every outcome is collected and returned.
 */
export async function sendBulk(
  recipients: Recipient[],
  subject: string,
  body: string,
): Promise<SendResult[]> {
  const transport = getTransport();
  const from = mailFrom();
  const results: SendResult[] = [];

  for (const [i, person] of recipients.entries()) {
    const text = personalize(body, person);
    try {
      await transport.sendMail({
        from,
        to: person.name ? `"${person.name}" <${person.email}>` : person.email,
        subject: personalize(subject, person),
        text,
        html: textToHtml(text),
      });
      results.push({ email: person.email, ok: true });
    } catch (e) {
      results.push({
        email: person.email,
        ok: false,
        error: e instanceof Error ? e.message : "send failed",
      });
    }

    // No need to wait after the final message.
    if (i < recipients.length - 1) await sleep(SEND_GAP_MS);
  }

  return results;
}

/**
 * Substitute the per-recipient placeholders an admin can type into the composer.
 *
 * `{{name}}` falls back to the address's local part, so a template still reads
 * as a greeting for accounts that never set a name.
 */
export function personalize(template: string, person: Recipient): string {
  const name = person.name?.trim() || person.email.split("@")[0];
  return template
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .replace(/\{\{\s*email\s*\}\}/g, person.email);
}

/**
 * Wrap a plain-text body in minimal HTML.
 *
 * Admins compose in plain text, but a mail with no HTML part looks like
 * machine output in most clients. This keeps the text as written — escaped,
 * with blank lines becoming paragraphs — rather than inventing a layout the
 * author didn't ask for.
 */
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 16px">${block.replace(/\n/g, "<br>")}</p>`)
    .join("");

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1f2933">${paragraphs}</div>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
