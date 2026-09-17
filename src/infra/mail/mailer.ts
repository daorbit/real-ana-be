
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer, { type Transporter } from "nodemailer";
import { LOGO_DATA_URI } from "../../modules/seo/logo.js";
import { bannerAttachment, type BannerName } from "./templates/shared.js";
import { verificationCodeHtml, verificationCodeText } from "./templates/verification-code.js";
import { passwordResetHtml, passwordResetText } from "./templates/password-reset.js";
import { passwordChangeHtml, passwordChangeText } from "./templates/password-change.js";
import { bannerShell, greetingLine, line as bannerLine, signOff, warningPanel, escapeHtml as escapeHtmlShared } from "./templates/shared.js";
import { twoFactorBackupCodesHtml, twoFactorBackupCodesText } from "./templates/two-factor-backup-codes.js";
import { inviteHtml as workspaceInviteBody, inviteText as workspaceInviteTextBody } from "./templates/invite.js";
import { paymentReceivedHtml, paymentReceivedText } from "./templates/payment-received.js";
import { planEndHtml, planEndText } from "./templates/plan-end.js";
import {
  welcomeHtml as welcomeBody,
  welcomeText,
  signupWelcomeIntro,
  signupWelcomeCta,
} from "./templates/welcome.js";
import { installSnippetHtml } from "./templates/install-snippet.js";
import { seoAuditHtml } from "./templates/seo-audit.js";
import { coldInviteHtml } from "./templates/cold-invite.js";

/** Which banner each designed layout carries. "plain" and "invite" have none. */
const LAYOUT_BANNERS: Partial<Record<BodyLayout, BannerName>> = {
  install: "install-snippet",
  welcome: "welcome",
  feature: "seo-audit",
  invite: "cold-invite",
};

/** Gap between messages. Slow enough that Gmail doesn't read a batch as a burst. */
const SEND_GAP_MS = 400;

/**
 * Where the links in an email point.
 *
 * Overridable by environment so a staging deploy doesn't send mail linking at
 * production, with the real hosts as defaults — a broken link in an email
 * cannot be fixed after it is sent, so the fallback has to be the right one.
 */
const LINKS = {
  get site() {
    return process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in";
  },
  get app() {
    return process.env.PUBLIC_APP_URL || "https://studio-quantalog.daorbit.in";
  },
  get docs() {
    return `${process.env.PUBLIC_SITE_URL || "https://quantalog.daorbit.in"}/docs`;
  },
};

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


export async function sendBulk(
  recipients: Recipient[],
  subject: string,
  body: string,
  cta?: { label: string; href: string },
  /**
   * Which body layout to render.
   *
   * "invite" swaps the plain-text renderer for the designed feature list, for
   * the one template that goes to people who have never heard of the product.
   */
  layout: BodyLayout = "plain",
): Promise<SendResult[]> {
  const transport = getTransport();
  const from = mailFrom();
  const results: SendResult[] = [];
  // The designed layouts reference their banner by cid, so the part has to be
  // on every message that uses one.
  const banner = LAYOUT_BANNERS[layout] ? bannerAttachment(LAYOUT_BANNERS[layout]!) : null;

  for (const [i, person] of recipients.entries()) {
    const text = personalize(body, person);
    try {
      await transport.sendMail({
        from,
        to: person.name ? `"${person.name}" <${person.email}>` : person.email,
        subject: personalize(subject, person),
        text,
        html: renderBody(layout, text, cta),
        attachments: banner ? [LOGO_ATTACHMENT, banner] : [LOGO_ATTACHMENT],
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


export function personalize(template: string, person: Recipient): string {
  const name = person.name?.trim() ?? "";

  return (
    template

      .replace(/\{\{\s*greeting\s*\}\}/g, greeting(name))
      .replace(/\{\{\s*name\s*\}\}/g, name)
      .replace(/\{\{\s*email\s*\}\}/g, person.email)

      .replace(/[ \t]+([,!.?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
  );
}


function greeting(name: string): string {
  return name ? `Hi ${name}` : "Hello";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export async function sendOne(
  to: Recipient,
  subject: string,
  text: string,
  html?: string,
  /** Files to send alongside the message — the logo part is added for you. */
  attachments: { filename: string; content: Buffer; contentType?: string; cid?: string }[] = [],
  /** Extra headers, e.g. `List-Unsubscribe` on mail to people without an account. */
  headers?: Record<string, string>,
): Promise<void> {
  await getTransport().sendMail({
    from: mailFrom(),
    to: to.name ? `"${to.name}" <${to.email}>` : to.email,
    subject,
    text,
    // Everything goes out branded — an unstyled fallback would be the one
    // message that looks like it came from somewhere else.
    html: html ?? broadcastHtml(text),
    // The shell references the logo by cid, so the part must ride along.
    attachments: [LOGO_ATTACHMENT, ...attachments],
    ...(headers ? { headers } : {}),
  });
}


export async function sendOtpEmail(
  to: Recipient,
  code: string,
  minutes: number,
): Promise<void> {
  const banner = bannerAttachment("verification-code");

  await sendOne(
    to,
    `${code} is your Quantalog verification code`,
    verificationCodeText(code, minutes, to.name),
    verificationCodeHtml(code, minutes, to.name),
    // The markup references the banner by cid, so the part has to ride along —
    // same contract as the logo.
    banner ? [banner] : [],
  );
}


export async function sendResetEmail(
  to: Recipient,
  code: string,
  minutes: number,
): Promise<void> {
  const banner = bannerAttachment("password-reset");

  await sendOne(
    to,
    `${code} is your Quantalog password reset code`,
    passwordResetText(code, minutes, to.name),
    passwordResetHtml(code, minutes, to.name),
    banner ? [banner] : [],
  );
}


export async function sendTwoFactorBackupCodesEmail(to: Recipient, codes: string[]): Promise<void> {
  const banner = bannerAttachment("two-factor-backup-codes");

  await sendOne(
    to,
    "Your Quantalog two-factor backup codes",
    twoFactorBackupCodesText(codes, to.name),
    twoFactorBackupCodesHtml(codes, to.name),
    banner ? [banner] : [],
  );
}

/**
 * Sent whenever a superadmin resets a security setting on someone's account
 * (2FA, screen lock) on their behalf, typically after a support request from
 * someone who lost their authenticator or PIN. Same shell as the password-
 * change notice, for the same reason: a security downgrade that happened
 * without the account holder typing anything themselves is exactly the kind
 * of change worth a receipt.
 */
export async function sendAdminSecurityResetEmail(to: Recipient, what: string): Promise<void> {
  const banner = bannerAttachment("password-change");

  await sendOne(
    to,
    `${what} on your Quantalog account`,
    adminSecurityResetText(what, to.name),
    adminSecurityResetHtml(what, to.name),
    banner ? [banner] : [],
  );
}

function adminSecurityResetHtml(what: string, name?: string): string {
  return bannerShell(
    "password-change",
    `${greetingLine(name)}
     ${bannerLine(`${escapeHtmlShared(what)} by our support team, at your request.`)}
     ${warningPanel(
       `<strong style="color:${C.text}">If you didn't ask for this</strong>, contact support right away — someone reaching us with your details could be trying to take over your account.`,
     )}
     ${signOff()}`,
  );
}

function adminSecurityResetText(what: string, name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

${what} by our support team, at your request.

If you didn't ask for this, contact support right away — someone reaching us with your details could be trying to take over your account.

The Quantalog Team`;
}

/** Sent the moment five wrong passwords in a row trip the 12-hour login lock
 * — the account holder should hear about this from us before they hear it
 * from the login screen, and if it wasn't them trying, this is the signal
 * that someone else has their password. */
export async function sendAccountLockedEmail(to: Recipient, lockedUntil: Date): Promise<void> {
  const banner = bannerAttachment("password-change");
  const until = lockedUntil.toLocaleString("en-GB", {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });

  await sendOne(
    to,
    "Your Quantalog account is temporarily locked",
    accountLockedText(until, to.name),
    accountLockedHtml(until, to.name),
    banner ? [banner] : [],
  );
}

function accountLockedHtml(until: string, name?: string): string {
  return bannerShell(
    "password-change",
    `${greetingLine(name)}
     ${bannerLine("Five wrong passwords in a row were entered on your Quantalog account, so sign-in has been paused for 12 hours as a precaution.")}
     ${warningPanel(
       `<strong style="color:${C.text}">Locked until ${escapeHtmlShared(until)}.</strong> If this wasn't you, your password may be known to someone else — change it as soon as the lock lifts.`,
     )}
     ${bannerLine("If it was you, there's nothing to do — sign-in opens again on its own once the lock passes.", 18)}
     ${signOff()}`,
  );
}

function accountLockedText(until: string, name?: string): string {
  return `Hello${name?.trim() ? ` ${name.trim()}` : ""},

Five wrong passwords in a row were entered on your Quantalog account, so sign-in has been paused for 12 hours as a precaution.

Locked until ${until}. If this wasn't you, your password may be known to someone else — change it as soon as the lock lifts.

If it was you, there's nothing to do — sign-in opens again on its own once the lock passes.

The Quantalog Team`;
}

export async function sendPasswordChangedEmail(to: Recipient): Promise<void> {
  const banner = bannerAttachment("password-change");

  await sendOne(
    to,
    "Your Quantalog password was changed",
    passwordChangeText(to.name),
    passwordChangeHtml(to.name),
    banner ? [banner] : [],
  );
}

/**
 * Sent once, when an account is first created.
 *
 * Fired from every path that creates a user — password signup, Google and
 * LinkedIn sign-in alike — because the blocker it addresses is the same either
 * way: someone with an account and no site on it yet.
 */
export async function sendWelcomeEmail(to: Recipient): Promise<void> {
  const banner = bannerAttachment("welcome");

  await sendOne(
    to,
    "Welcome to Quantalog",
    welcomeText(to.name),
    welcomeBody(signupWelcomeIntro(to.name), signupWelcomeCta()),
    banner ? [banner] : [],
  );
}

const LOGO_CID = "quantalog-logo";

export const LOGO_ATTACHMENT = {
  filename: "quantalog.png",
  content: Buffer.from(LOGO_DATA_URI.split(",")[1], "base64"),
  cid: LOGO_CID,
  contentType: "image/png",
};

const LOGO_IMG = `<img src="cid:${LOGO_CID}" width="28" height="28" alt="Quantalog"
  style="display:block;border:0;outline:none;text-decoration:none;width:28px;height:28px">`;

export const C = {
  /** Behind the card. Barely off-white, so the card reads as a distinct sheet. */
  page: "#f5f6f8",
  card: "#ffffff",
  /** Insets — the code block, quoted messages, receipt summaries. */
  panel: "#f3f4f6",
  line: "#e5e7eb",
  /** Headings. Near-black, not pure, which is harsh at large sizes. */
  text: "#111827",
  /** Body copy. */
  dim: "#4b5563",
  /** Small print and labels. Passes AA on both the card and the panel. */
  faint: "#6b7280",
  accent: "#059669",
  accentDeep: "#047857",
  danger: "#dc2626",
} as const;


const S = { tight: 8, block: 16, section: 24, major: 32 } as const;


const T = {
  title: `font-size:18px;font-weight:700;line-height:1.4;letter-spacing:-0.3px;color:${C.text}`,
  body: `font-size:14.5px;line-height:1.65;color:${C.dim}`,
  small: `font-size:12.5px;line-height:1.6;color:${C.faint}`,
} as const;

export type Align = "center" | "left";

/** The heading that opens a message. */
export function heading(text: string, align: Align = "center"): string {
  return `<p style="margin:0;${T.title};text-align:${align}">${text}</p>`;
}

/** A paragraph of body copy. `top` is the gap above it, from the scale. */
export function paragraph(html: string, top: number = S.block, align: Align = "center"): string {
  return `<p style="margin:${top}px 0 0;${T.body};text-align:${align}">${html}</p>`;
}

export function footnote(html: string, align: Align = "center"): string {
  return `<p style="margin:${S.section}px 0 0;${T.small};text-align:${align}">${html}</p>`;
}


export function label(text: string, top: number = S.section): string {
  return `<p style="margin:${top}px 0 ${S.tight}px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint}">${text}</p>`;
}


export function codePanel(code: string, minutes: number): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0">
    <tr><td class="panel" align="center" style="background:${C.panel};border-radius:10px;padding:26px 20px">
      <div style="font-size:27px;font-weight:700;letter-spacing:6px;text-indent:6px;line-height:1.25;color:${C.text};word-break:break-all">${code}</div>
    </td></tr>
  </table>
  ${paragraph(`This code expires in ${minutes} minutes.`, S.block)}`;
}


export function statTile(
  label: string,
  value: string,
  delta?: string,
  tone: "up" | "down" | "flat" = "flat",
  lastRow = false,
): string {
  const toneColor = tone === "up" ? C.accent : tone === "down" ? C.danger : C.faint;
  // A hairline border rather than a filled panel: six solid-grey boxes read as
  // a wall of cards, where a thin rule around white space reads as a clean
  // number grid — the same numbers, without the box-y feel.
  return `<td width="50%" style="padding:14px 4px;vertical-align:top;${lastRow ? "" : `border-bottom:1px solid ${C.line};`}">
    <div style="font-size:10.5px;letter-spacing:0.7px;text-transform:uppercase;color:${C.faint};font-weight:600">${label}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:5px"><tr>
      <td style="font-size:21px;font-weight:700;color:${C.text};line-height:1;letter-spacing:-0.2px">${value}</td>
      ${delta ? `<td style="padding-left:8px;font-size:12px;font-weight:600;color:${toneColor}">${delta}</td>` : ""}
    </tr></table>
  </td>`;
}


export function barRow(label: string, value: string, pct: number): string {
  const width = Math.max(2, Math.min(100, Math.round(pct)));
  // A 3px track rather than 7px, and the label above the bar instead of beside
  // it — three columns squeezed a long page path into 150px of ellipsis; one
  // column gives the path room to actually be read.
  return `<tr>
    <td style="padding:11px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="font-size:12.5px;color:${C.dim};padding-bottom:6px">${label}</td>
          <td style="font-size:12.5px;font-weight:600;color:${C.text};text-align:right;padding-bottom:6px;white-space:nowrap">${value}</td>
        </tr>
        <tr><td colspan="2">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.line};border-radius:2px">
            <tr><td style="width:${width}%;height:3px;background:${C.accent};border-radius:2px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr>
          </table>
        </td></tr>
      </table>
    </td>
  </tr>`;
}


export function button(label: string, href: string): string {

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" style="background:${C.accentDeep};border-radius:8px;mso-padding-alt:11px 22px">
        <a href="${href}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;line-height:1;color:#ffffff !important;text-decoration:none !important;letter-spacing:-0.1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${label}</a>
      </td>
    </tr></table>
  </td></tr></table>`;
}


const DEFAULT_REASON = "";


export type ShellFooter = "product" | "minimal";

export function shell(
  inner: string,
  reason: string = DEFAULT_REASON,
  footer: ShellFooter = "product",
): string {
  return `<div style="background:${C.page};padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <!--[if mso]>
  <style>
    /* Outlook's Word engine drops border-radius and renders every background
       it does keep without antialiasing, so rounded cards come out as square
       boxes with ragged edges. Squaring them deliberately looks intentional;
       leaving them to Word does not. */
    .card, .panel { border-radius: 0 !important; }
  </style>
  <![endif]-->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto">

    <!-- One card, not three stacked panels. The header/body/footer used to be
         separate cells with their own backgrounds and shared borders, which is
         what made the message read as a stack of boxes rather than a letter. -->
    <tr><td class="card" style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:${S.major}px">

      <!-- Logo, centred, on the card's own white. The old header sat the mark
           on its own darker band, which fought the card it was attached to. -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto ${S.major}px"><tr>
        <td style="padding-right:9px;vertical-align:middle">${LOGO_IMG}</td>
        <td style="vertical-align:middle;font-size:17px;font-weight:700;color:${C.text};letter-spacing:-0.3px">Quantalog<span style="color:${C.accent}">.</span></td>
      </tr></table>

      ${inner}

      <!-- Footer, inside the card and behind a rule. Outside it, in its own
           panel, it read as a second message rather than the end of this one. -->
      <div style="margin-top:${S.major}px;padding-top:${S.section}px;border-top:1px solid ${C.line};text-align:center">
        ${
          footer === "product"
            ? `<p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:${C.faint}">
          Real-time analytics, SEO audits and a multi-tenant API — from one script tag.
        </p>`
            : ""
        }
        <p style="margin:0;font-size:13px">
          <a href="${LINKS.app}" style="color:${C.accent};text-decoration:none;font-weight:600">Dashboard</a>
          <span style="color:${C.line}"> &nbsp;·&nbsp; </span>
          <a href="${LINKS.docs}" style="color:${C.accent};text-decoration:none;font-weight:600">Docs</a>
          <span style="color:${C.line}"> &nbsp;·&nbsp; </span>
          <a href="${LINKS.site}" style="color:${C.accent};text-decoration:none;font-weight:600">Website</a>
        </p>
      </div>
    </td></tr>

    ${

      reason
        ? `<tr><td style="padding:${S.section}px 8px 0;text-align:center">
      <p style="margin:0;font-size:11.5px;line-height:1.7;color:${C.faint}">${reason}</p>
    </td></tr>`
        : ""
    }
  </table>
</div>`;
}

/* ------------------------------- code emails ------------------------------ */

export { verificationCodeHtml as otpHtml } from "./templates/verification-code.js";
export { passwordResetHtml as resetHtml } from "./templates/password-reset.js";
export { passwordChangeHtml as passwordChangedHtml } from "./templates/password-change.js";


export function broadcastHtml(text: string, cta?: { label: string; href: string }): string {
  const blocks = escapeHtml(text).split(/\n{2,}/);

  const paragraphs = blocks
    .map((block, i) => {
      const html = block.replace(/\n/g, "<br>");

      const style =
        i === 0
          ? `margin:0 0 ${S.block}px;font-size:15.5px;font-weight:600;color:${C.text};line-height:1.6`
          : `margin:0 0 ${S.block}px;${T.body}`;
      return `<p style="${style}">${html}</p>`;
    })
    .join("");


  const action =
    cta && /^https?:\/\//i.test(cta.href)
      ? button(escapeHtml(cta.label), escapeAttr(cta.href))
      : "";

  return shell(paragraphs + action);
}


export function codeBlock(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.block}px 0 0">
    <tr><td class="panel" style="background:${C.panel};border-radius:10px;padding:16px 18px">
      <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;color:${C.text};word-break:break-all">${escapeHtml(code)}</code>
    </td></tr>
  </table>`;
}

export function step(n: number, title: string, body: string): string {
  return `<tr>
    <td width="26" style="padding:0 0 14px;vertical-align:top">
      <div style="width:20px;height:20px;border-radius:50%;background:${C.accent};color:#ffffff;font-size:11px;font-weight:700;line-height:20px;text-align:center">${n}</div>
    </td>
    <td style="padding:0 0 14px;vertical-align:top">
      <p style="margin:0;font-size:14px;font-weight:600;color:${C.text}">${title}</p>
      <p style="margin:3px 0 0;font-size:13px;line-height:1.6;color:${C.dim}">${body}</p>
    </td>
  </tr>`;
}

/** Wraps `step` rows into their own table. */
export function steps(rows: string[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0">${rows.join("")}</table>`;
}


export type BodyLayout = "plain" | "invite" | "install" | "welcome" | "feature";


/** Picks the renderer for a layout, falling back to plain where a CTA is required. */
export function renderBody(
  layout: BodyLayout,
  text: string,
  cta?: { label: string; href: string },
): string {
  // The layouts below all end in a button and are pointless without one, so a
  // template missing its CTA degrades to plain prose rather than shipping a
  // designed body with no way out of it.
  if (!cta) return broadcastHtml(text, cta);

  switch (layout) {
    case "invite":
      return coldInviteHtml(text, cta);
    case "install":
      return installSnippetHtml(text, cta);
    case "welcome":
      return welcomeBody(text, cta);
    case "feature":
      return seoAuditHtml(text, cta);
    default:
      return broadcastHtml(text, cta);
  }
}


function intro(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block, i) => {
      const html = block.replace(/\n/g, "<br>");
      const style =
        i === 0
          ? `margin:0 0 14px;font-size:15.5px;font-weight:600;color:${C.text};line-height:1.6`
          : `margin:0 0 14px;${T.body}`;
      return `<p style="${style}">${html}</p>`;
    })
    .join("");
}


function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}


export function forBrowser(html: string): string {

  return html
    .replace(`cid:${LOGO_CID}`, LOGO_DATA_URI)
    .replace(/cid:quantalog-banner-([a-z-]+)/g, (whole, name: string) => {
      const part = bannerAttachment(name as BannerName);
      return part ? `data:image/jpeg;base64,${part.content.toString("base64")}` : whole;
    });
}


export function contactAckHtml(name: string, subject: string, message: string): string {
  const quoted = escapeHtml(message).replace(/\n/g, "<br>");


  return shell(
    `${heading(`Thanks, ${escapeHtml(name)} — we have your message.`, "left")}
    ${paragraph(
      "A person reads every message that comes through this form. You should hear back at this address within one working day.",
      S.block,
      "left",
    )}

    ${label("What you sent")}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td class="panel" style="background:${C.panel};border-radius:10px;padding:18px 20px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.faint}">Subject</p>
        <p style="margin:0;font-size:14.5px;font-weight:600;line-height:1.5;color:${C.text}">${escapeHtml(subject)}</p>
        <div style="height:1px;background:${C.line};margin:${S.block}px 0"></div>
        <p style="margin:0;font-size:14px;line-height:1.75;color:${C.dim}">${quoted}</p>
      </td></tr>
    </table>

    ${paragraph(
      "No need to reply to this — it is just a receipt. If you remember something you left out, reply to this email and it will reach the same place.",
      S.section,
      "left",
    )}`,
  );
}

/** The plain-text half of the acknowledgement, for clients that refuse HTML. */
export function contactAckText(name: string, subject: string, message: string): string {
  return [
    `Thanks, ${name} — we have your message.`,
    "",
    "A person reads every message that comes through this form. You should hear back at this address within one working day.",
    "",
    `Subject: ${subject}`,
    "",
    message,
    "",
    "No need to reply to this — it is just a receipt.",
  ].join("\n");
}


export async function sendInvoiceEmail(
  to: Recipient,
  invoice: {
    number: string;
    description: string;
    amountLabel: string;
    paymentId: string;
    dateLabel: string;
  },
  pdf: Buffer,
): Promise<void> {
  const text = [
    `Payment received — thank you.`,
    "",
    `Receipt ${invoice.number}`,
    `${invoice.description}`,
    `Amount paid: ${invoice.amountLabel}`,
    `Date: ${invoice.dateLabel}`,
    `Payment reference: ${invoice.paymentId}`,
    "",
    "Your receipt is attached as a PDF. You can also download it any time from Billing in your dashboard:",
    `${LINKS.app}/billing`,
    "",
    "This is a payment receipt, not a tax invoice — no GST has been charged or collected.",
  ].join("\n");

  const banner = bannerAttachment("payment-received");

  await sendOne(
    to,
    `Receipt ${invoice.number} — payment received`,
    paymentReceivedText(invoice, to.name),
    paymentReceivedHtml(invoice, to.name),
    [
      {
        filename: `${invoice.number}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
      ...(banner ? [banner] : []),
    ],
  );
}

/** One label/value line in the receipt summary panel. */
function invoiceRow(label: string, value: string, strong = false): string {
  return `<tr>
    <td style="padding:7px 0;font-size:13px;color:${C.faint};white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:7px 0;font-size:${strong ? "15px" : "13px"};font-weight:${strong ? "700" : "500"};color:${strong ? C.accent : C.text};text-align:right">${escapeHtml(value)}</td>
  </tr>`;
}

export function invoiceHtml(invoice: {
  number: string;
  description: string;
  amountLabel: string;
  paymentId: string;
  dateLabel: string;
}): string {
  // Left-aligned throughout: a receipt is a document someone files or forwards
  // to an accountant, and a centred one reads as a notification rather than a
  // record.
  return shell(
    `${heading("Payment received", "left")}
     ${paragraph(
       "Thanks — your payment went through and your account has already been updated. Your receipt is attached to this email as a PDF.",
       S.block,
       "left",
     )}

     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0">
       <tr><td class="panel" style="background:${C.panel};border-radius:10px;padding:20px">
         <p style="margin:0 0 ${S.tight}px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint}">
           Receipt ${escapeHtml(invoice.number)}
         </p>
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
           ${invoiceRow("Item", invoice.description)}
           ${invoiceRow("Date", invoice.dateLabel)}
           ${invoiceRow("Payment reference", invoice.paymentId || "—")}
           <tr><td colspan="2" style="padding:6px 0"><div style="height:1px;background:${C.line}"></div></td></tr>
           ${invoiceRow("Total paid", invoice.amountLabel, true)}
         </table>
       </td></tr>
     </table>

     ${footnote(
       "This is a payment receipt, not a tax invoice — no GST has been charged or collected. Every receipt stays available under Billing in your dashboard.",
       "left",
     )}

     ${button("View billing", `${LINKS.app}/billing`)}`,
  );
}


export function newsletterAckHtml(): string {
  return shell(
    `${heading("You're on the list.")}
     ${paragraph(
       "We write when there is something worth reading — new features, and what we learn building analytics that runs without cookies. A few times a month at most, and never a sales sequence.",
     )}
     ${paragraph(
       "Nothing to do from here. To stop, reply with &quot;unsubscribe&quot; and you're off the list.",
     )}

     ${button("Try the live demo", LINKS.site)}`,
    // A subscriber has no account, and this is list mail — the line under the
    // card is where an unsubscribe route has to stay visible.
    "You subscribed to the Quantalog newsletter on quantalog.daorbit.in. Reply with \"unsubscribe\" to stop.",
  );
}

/** The plain-text half, for clients that refuse HTML. */
export function newsletterAckText(): string {
  return [
    "You're on the list.",
    "",
    "We write when there is something worth reading — new features, and what we learn building analytics that runs without cookies. A few times a month at most, and never a sales sequence.",
    "",
    "Nothing to do from here. To stop, reply with \"unsubscribe\" and you're off the list.",
    "",
    `Try the live demo: ${LINKS.site}`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


export async function sendWorkspaceInviteEmail(
  to: Recipient,
  invite: {
    workspaceName: string;
    inviterName: string;
    role: string;
    token: string;
    expiresInDays: number;
    /** False when the address has no account yet, so the copy says "sign up". */
    hasAccount: boolean;
  },
): Promise<void> {
  const link = `${LINKS.app}/invite/${invite.token}`;
  const what = invite.hasAccount
    ? "Sign in to accept it."
    : "You'll be asked to create an account first — use this address, and the workspace will be waiting.";

  const roleLine =
    invite.role === "viewer"
      ? "You'll have view-only access: you can see everything, and nothing you do can change it."
      : invite.role === "editor"
        ? "You'll be able to add sites, run audits, and manage reports."
        : "You'll be able to manage the workspace, including inviting other people.";

  const text = `${invite.inviterName} invited you to the "${invite.workspaceName}" workspace on Quantalog.

${roleLine}

${what}

${link}

This invitation expires in ${invite.expiresInDays} days. If you weren't expecting it, you can ignore this email — nothing has been shared with you until you accept.`;

  const banner = bannerAttachment("invite");

  await sendOne(
    to,
    `${invite.inviterName} invited you to ${invite.workspaceName} on Quantalog`,
    workspaceInviteTextBody(invite, link),
    workspaceInviteBody(invite, link, to.name),
    banner ? [banner] : [],
  );
}

export async function sendPlanExpiryEmail(
  to: Recipient,
  info: { workspaceName: string; planName: string; daysLeft: number; endsOn: Date },
): Promise<void> {
  const link = `${LINKS.app}/app/billing`;
  const when =
    info.daysLeft <= 1 ? "tomorrow" : `in ${info.daysLeft} days`;
  const endsOn = info.endsOn.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const text = `Your ${info.planName} plan for "${info.workspaceName}" ends ${when}, on ${endsOn}.

Plans do not renew automatically, so nothing will be charged. When the period ends the workspace drops to the Free plan: tracking continues at Free's allowance and everything already collected stays readable, but the paid features stop.

Renew here: ${link}`;

  const banner = bannerAttachment("plan-end");

  await sendOne(
    to,
    `Your ${info.planName} plan ends ${when}`,
    planEndText(info, link, when, endsOn, to.name),
    planEndHtml(info, link, when, endsOn, to.name),
    banner ? [banner] : [],
  );
}

export function planExpiryHtml(
  info: { workspaceName: string; planName: string; daysLeft: number },
  link: string,
  when: string,
  endsOn: string,
): string {
  return shell(
    `${heading(`Your plan ends ${when}`)}
     ${paragraph(
       `The <strong style="color:${C.text}">${escapeHtml(info.planName)}</strong> plan for this workspace is coming to an end.`,
     )}

     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.block}px 0 0">
       <tr><td class="panel" align="center" style="background:${C.panel};border-radius:10px;padding:18px 20px">
         <p style="margin:0;font-size:16px;font-weight:700;line-height:1.4;color:${C.text};letter-spacing:-0.2px">${escapeHtml(info.workspaceName)}</p>
         <p style="margin:5px 0 0;font-size:13px;line-height:1.6;color:${C.faint}">Ends on ${escapeHtml(endsOn)}</p>
       </td></tr>
     </table>

     ${paragraph(
       "Plans do not renew automatically, so nothing will be charged. When the period ends the workspace drops to the Free plan — tracking continues at Free's allowance and everything already collected stays readable, but the paid features stop.",
     )}

     ${button("Renew plan", link)}

     ${footnote(
       "If you have already renewed, or meant to let this lapse, you can ignore this email.",
     )}`,
  );
}

export function workspaceInviteHtml(
  invite: { workspaceName: string; inviterName: string; expiresInDays: number },
  link: string,
  roleLine: string,
  what: string,
): string {
  // The workspace name gets its own block rather than sitting inside a
  // sentence. What the reader is deciding is whether to join *this* workspace,
  // and an invite that makes them parse a paragraph to find its name is the
  // kind that gets mistaken for phishing.
  return shell(
    `${heading("You've been invited to a workspace")}
     ${paragraph(
       `<strong style="color:${C.text}">${escapeHtml(invite.inviterName)}</strong> invited you to join`,
     )}

     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.block}px 0 0">
       <tr><td class="panel" align="center" style="background:${C.panel};border-radius:10px;padding:18px 20px">
         <p style="margin:0;font-size:16px;font-weight:700;line-height:1.4;color:${C.text};letter-spacing:-0.2px">${escapeHtml(invite.workspaceName)}</p>
         <p style="margin:5px 0 0;font-size:13px;line-height:1.6;color:${C.faint}">${escapeHtml(roleLine)}</p>
       </td></tr>
     </table>

     ${paragraph(escapeHtml(what))}

     ${button("Accept invitation", link)}

     ${footnote(
       `This invitation expires in ${invite.expiresInDays} days. If you weren't expecting it, you can ignore this email — nothing has been shared with you until you accept.`,
     )}`,
    undefined,
    "minimal",
  );
}
