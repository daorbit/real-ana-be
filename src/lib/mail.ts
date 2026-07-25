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

/**
 * Send one message and report whether it left.
 *
 * Separate from `sendBulk` because the caller here is a user waiting on a page:
 * a failure needs to surface as a failure, not be buried in a results array.
 */
export async function sendOne(
  to: Recipient,
  subject: string,
  text: string,
  html?: string,
): Promise<void> {
  await getTransport().sendMail({
    from: mailFrom(),
    to: to.name ? `"${to.name}" <${to.email}>` : to.email,
    subject,
    text,
    html: html ?? textToHtml(text),
  });
}

/**
 * The signup verification email.
 *
 * The code is repeated in the subject line so it is readable from a
 * notification without opening anything, and set large and spaced in the body
 * because the common case is reading it off a phone while typing on a laptop.
 */
export async function sendOtpEmail(
  to: Recipient,
  code: string,
  minutes: number,
): Promise<void> {
  const text = `Your Quantalog verification code is ${code}

It expires in ${minutes} minutes. Enter it on the signup page to finish creating your account.

If you didn't try to sign up, you can ignore this email — no account has been created.`;

  await sendOne(to, `${code} is your Quantalog verification code`, text, otpHtml(code, minutes));
}

 
function otpHtml(code: string, minutes: number): string {
  // The wordmark from the app sidebar. Sized in the SVG itself because several
  // clients ignore width/height attributes on inline SVG.
  const logo = `<svg width="30" height="30" viewBox="0 0 36 36" fill="none" style="display:block">
    <defs><linearGradient id="q" x1="4" y1="4" x2="32" y2="32" gradientUnits="userSpaceOnUse">
      <stop stop-color="#34d399"/><stop offset="1" stop-color="#059669"/>
    </linearGradient></defs>
    <rect x="1" y="1" width="34" height="34" rx="11" fill="url(#q)"/>
    <path d="M8 19h4.2l2.3-7.5 4 15 2.6-11 1.7 3.5H28" stroke="#fff" stroke-width="2.4"
      stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

  return `<div style="background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:440px;margin:0 auto">
    <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:32px">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:9px;vertical-align:middle">${logo}</td>
        <td style="vertical-align:middle;font-size:19px;font-weight:700;color:#111827;letter-spacing:-0.2px">Quantalog<span style="color:#10b981">.</span></td>
      </tr></table>

      <p style="margin:28px 0 0;font-size:16px;font-weight:600;color:#111827">Verify your email address</p>
      <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#6b7280">
        Enter this code on the signup page to finish creating your account.
      </p>

      <div style="margin:24px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:20px;text-align:center">
        <div style="font-size:32px;font-weight:700;letter-spacing:9px;color:#111827;font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace">${code}</div>
      </div>

      <p style="margin:0;font-size:13px;color:#6b7280">
        This code expires in ${minutes} minutes.
      </p>

      <div style="margin:24px 0 0;padding-top:20px;border-top:1px solid #f3f4f6">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af">
          Didn't try to sign up? You can ignore this email — no account has been created.
        </p>
      </div>

    </td></tr>
  </table>
</div>`;
}
