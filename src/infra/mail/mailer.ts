
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer, { type Transporter } from "nodemailer";
import { LOGO_DATA_URI } from "../../modules/seo/logo.js";

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

  for (const [i, person] of recipients.entries()) {
    const text = personalize(body, person);
    try {
      await transport.sendMail({
        from,
        to: person.name ? `"${person.name}" <${person.email}>` : person.email,
        subject: personalize(subject, person),
        text,
        html: renderBody(layout, text, cta),
        attachments: [LOGO_ATTACHMENT],
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
  const name = person.name?.trim() ?? "";

  return (
    template
      // `{{greeting}}` is the one to reach for on a message to strangers: it
      // becomes "Hi Alex" when a name is known and a plain "Hello" when it
      // isn't. Resolved before `{{name}}` because it contains it.
      .replace(/\{\{\s*greeting\s*\}\}/g, greeting(name))
      .replace(/\{\{\s*name\s*\}\}/g, name)
      .replace(/\{\{\s*email\s*\}\}/g, person.email)
      // An empty `{{name}}` leaves "Hi ," and a double space behind. Tidying
      // those is what keeps the no-name case from reading as a broken merge —
      // and it is only whitespace and stray punctuation, so it can't reword
      // anything the author actually wrote.
      .replace(/[ \t]+([,!.?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
  );
}

/**
 * The opening line.
 *
 * A name when we have one. When we don't, a plain "Hello" — deliberately not the
 * address's local part, which turns a cold introduction into an obvious mail
 * merge ("Hi alex"), and deliberately not a time-of-day greeting: that is
 * computed when the message is sent, not when it is read, so "Good morning" on
 * something opened at midnight is wrong in exactly the way it was trying to
 * avoid.
 */
function greeting(name: string): string {
  return name ? `Hi ${name}` : "Hello";
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

  const banner = bannerAttachment();

  await sendOne(
    to,
    `${code} is your Quantalog verification code`,
    text,
    otpHtml(code, minutes, to.name),
    // The markup references the banner by cid, so the part has to ride along —
    // same contract as the logo.
    banner ? [banner] : [],
  );
}

/**
 * The password reset code.
 *
 * Separate from the signup OTP rather than sharing it: the two arrive in very
 * different situations, and the line that matters here — "if this wasn't you,
 * your password has not changed" — is the whole reason someone reads a reset
 * email they did not ask for.
 */
export async function sendResetEmail(
  to: Recipient,
  code: string,
  minutes: number,
): Promise<void> {
  const text = `Your Quantalog password reset code is ${code}

It expires in ${minutes} minutes. Enter it on the password reset page to choose a new password.

If you didn't ask to reset your password, you can ignore this email — your password has not changed, and nobody can change it without this code.`;

  const banner = bannerAttachment();

  await sendOne(
    to,
    `${code} is your Quantalog password reset code`,
    text,
    resetHtml(code, minutes, to.name),
    banner ? [banner] : [],
  );
}

/**
 * Sent after a password actually changes.
 *
 * Not a courtesy: this is the only thing that tells the real owner their
 * password was changed by someone else, and it is the point at which a stolen
 * inbox stops being a silent takeover. It goes out on every successful reset,
 * including ones we believe are legitimate.
 */
export async function sendPasswordChangedEmail(to: Recipient): Promise<void> {
  const text = `Your Quantalog password was just changed.

If that was you, there is nothing to do.

If it wasn't, your account may be at risk — reset your password immediately at ${LINKS.app}/forgot-password, and check that your email account is still secure.`;

  await sendOne(to, "Your Quantalog password was changed", text, passwordChangedHtml());
}

/**
 * The content-id the logo is referenced by.
 *
 * Gmail strips `data:` URIs out of `<img src>` and drops inline `<svg>`
 * entirely, so neither survives the trip. What does work everywhere is a CID
 * attachment: the image travels as its own MIME part and the HTML points at it
 * by id. Every send therefore has to include `LOGO_ATTACHMENT` — the markup
 * alone is not enough.
 */
const LOGO_CID = "quantalog-logo";

/**
 * The logo as a MIME part.
 *
 * `cid` links it to the `<img>` below, and because it is referenced from the
 * body rather than listed on its own, clients show it inline instead of as a
 * downloadable attachment.
 */
export const LOGO_ATTACHMENT = {
  filename: "quantalog.png",
  content: Buffer.from(LOGO_DATA_URI.split(",")[1], "base64"),
  cid: LOGO_CID,
  contentType: "image/png",
};

const LOGO_IMG = `<img src="cid:${LOGO_CID}" width="28" height="28" alt="Quantalog"
  style="display:block;border:0;outline:none;text-decoration:none;width:28px;height:28px">`;

/**
 * The illustrated header strip the code emails open with.
 *
 * A CID part for the same reason the logo is one: Gmail drops `data:` URIs out
 * of `<img src>`, and a remote URL would be blocked until the recipient clicks
 * "show images" — on a message whose whole job is to be read in four seconds,
 * the banner would arrive as a grey box.
 */
const BANNER_CID = "quantalog-banner";

/** Read once and kept — the file never changes between sends. */
let bannerPart: { filename: string; content: Buffer; cid: string; contentType: string } | null = null;

/**
 * The banner as a MIME part, or null when the file isn't there.
 *
 * Resolved relative to this module so it works from `src` under tsx and from
 * `dist` after a build, and null-tolerant on purpose: a missing image should
 * cost the header strip, not the verification code someone is waiting on.
 */
function bannerAttachment() {
  if (bannerPart) return bannerPart;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/infra/mail -> dist -> package root
    path.join(here, "..", "..", "..", "public", "email-banner.jpg"),
    path.join(process.cwd(), "public", "email-banner.jpg"),
  ];

  for (const file of candidates) {
    try {
      bannerPart = {
        filename: "email-banner.jpg",
        content: readFileSync(file),
        cid: BANNER_CID,
        contentType: "image/jpeg",
      };
      return bannerPart;
    } catch {
      // Try the next location.
    }
  }

  return null;
}

/**
 * The warm accent the code emails use.
 *
 * Separate from `C` rather than replacing it: the orange is the identity of the
 * transactional messages — the ones that have to look unmistakably like they
 * came from us, because they are the ones phishing imitates — while receipts,
 * broadcasts and reports keep the emerald they already ship with.
 */
const O = {
  /**
   * The top of the page wash.
   *
   * Barely there on purpose. A wash strong enough to read as orange competes
   * with the banner it is supposed to be continuing, and turns the white code
   * box into the second-brightest thing on the page instead of the first.
   */
  washTop: "#fff7f0",
  /** The banner's own wash. Also the code box's edge, which needs to be seen. */
  tint: "#ffe6d2",
  accent: "#f97316",
  accentDeep: "#ea580c",
} as const;

/**
 * The shell every outgoing message shares: logo, card, footer.
 *
 * Built for mail clients rather than browsers, which is why it looks dated —
 * tables instead of flexbox, inline styles instead of a stylesheet, no external
 * assets. Deliberately restrained: one accent colour on the mark, neutral grey
 * for everything else, so whatever `inner` puts in the card is what draws the
 * eye.
 */
/**
 * The palette, in one place.
 *
 * Named rather than inlined at each use because the same six values run through
 * every template, and a card that drifts one shade off the others is the kind
 * of thing nobody can point at but everybody notices.
 *
 * Light, and deliberately so. A dark email is a bet that the client will honour
 * your background colour — and the one that most reliably does not, Outlook's
 * Word engine, keeps the text colour while dropping the background, which turns
 * pale grey body copy on a near-black card into pale grey on white. A light
 * palette fails in the safe direction: dark text on a background that was going
 * to be white anyway.
 *
 * The neutrals carry a slight cool cast rather than being pure greys, so they
 * sit with the emerald instead of against it.
 */
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

/**
 * The vertical rhythm, as a scale rather than a number per call site.
 *
 * Every gap in these templates used to be typed by hand, which is how the same
 * "space between a heading and its paragraph" ended up as 8px in one message,
 * 10px in another and 12px in a third. Nobody can point at which one is wrong;
 * the set just reads as untidy. Four steps is enough for an email — there is
 * only ever a gap inside a block, between blocks, between sections, or around
 * the one that ends a message.
 */
const S = { tight: 8, block: 16, section: 24, major: 32 } as const;

/**
 * The type scale.
 *
 * Three sizes and one muted variant. An email is a single column with one
 * message in it; the moment there are five sizes, two of them are doing the
 * same job at slightly different weights.
 */
const T = {
  title: `font-size:18px;font-weight:700;line-height:1.4;letter-spacing:-0.3px;color:${C.text}`,
  body: `font-size:14.5px;line-height:1.65;color:${C.dim}`,
  small: `font-size:12.5px;line-height:1.6;color:${C.faint}`,
} as const;

/**
 * How a message is set.
 *
 * "centered" is for the short ones — a code, a confirmation, an alert. They are
 * four lines around a single object, and centring them puts that object on the
 * page's axis under the logo, which is the shape people already read as a
 * transactional email.
 *
 * "left" is for messages with real prose or a quoted block. Centred paragraphs
 * are hard to read past a couple of lines, because every line starts in a
 * different place.
 */
export type Align = "center" | "left";

/** The heading that opens a message. */
export function heading(text: string, align: Align = "center"): string {
  return `<p style="margin:0;${T.title};text-align:${align}">${text}</p>`;
}

/** A paragraph of body copy. `top` is the gap above it, from the scale. */
export function paragraph(html: string, top: number = S.block, align: Align = "center"): string {
  return `<p style="margin:${top}px 0 0;${T.body};text-align:${align}">${html}</p>`;
}

/**
 * The closing note — the caveat a message ends on.
 *
 * No rule above it. The card's own footer already draws one, and two hairlines
 * a few lines apart chopped the message into slices. Distance does the same job
 * here, and the smaller, lighter type is enough to mark it as an aside.
 */
export function footnote(html: string, align: Align = "center"): string {
  return `<p style="margin:${S.section}px 0 0;${T.small};text-align:${align}">${html}</p>`;
}

/**
 * A section label — the small uppercase line above a panel.
 *
 * Used by the receipt, the invite feature list and the quoted-message blocks,
 * which each had their own copy of these five properties.
 */
export function label(text: string, top: number = S.section): string {
  return `<p style="margin:${top}px 0 ${S.tight}px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint}">${text}</p>`;
}

/**
 * The verification code.
 *
 * A plain grey block with the code in near-black — no accent colour, no border.
 * Colouring the digits emerald made the code read as a link, and an outlined
 * box made it read as an empty input control. Neither is what this is: it is a
 * number to copy, and a quiet inset with weight on the digits says that without
 * any decoration at all.
 *
 * Set in the system UI face rather than a monospace. Six digits at 32px are
 * unambiguous either way, and monospace on a light card looks like a code
 * sample — something to run, not something to type.
 *
 * `word-break` is the phone insurance: a long code wraps inside the block
 * rather than pushing the card wider than the screen.
 */
export function codePanel(code: string, minutes: number): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0">
    <tr><td class="panel" align="center" style="background:${C.panel};border-radius:10px;padding:26px 20px">
      <div style="font-size:27px;font-weight:700;letter-spacing:6px;text-indent:6px;line-height:1.25;color:${C.text};word-break:break-all">${code}</div>
    </td></tr>
  </table>
  ${paragraph(`This code expires in ${minutes} minutes.`, S.block)}`;
}

/**
 * A labelled number.
 *
 * Laid out as a table cell rather than a flex child: this is the piece most
 * likely to end up in a grid, and Outlook supports neither flex nor grid.
 */
export function statTile(label: string, value: string, delta?: string, tone: "up" | "down" | "flat" = "flat"): string {
  const toneColor = tone === "up" ? C.accent : tone === "down" ? C.danger : C.faint;
  return `<td width="50%" class="panel" style="padding:16px 18px;background:${C.panel};border-radius:10px;vertical-align:top">
    <div style="font-size:11px;letter-spacing:0.8px;text-transform:uppercase;color:${C.faint};font-weight:700">${label}</div>
    <div style="font-size:22px;font-weight:700;color:${C.text};line-height:1.3;padding-top:4px">${value}</div>
    ${delta ? `<div style="font-size:12.5px;font-weight:600;color:${toneColor};padding-top:2px">${delta}</div>` : ""}
  </td>`;
}

/**
 * A horizontal bar row — the chart substitute.
 *
 * Real charts would mean an image, and an image in email is hidden until the
 * recipient clicks "show images" — which for a numbers email is exactly the
 * wrong thing to hide. A bar drawn as a table cell of a given width needs no
 * image, no SVG and no script, and is visible the moment the message opens.
 *
 * `pct` is the bar's share of full width, already normalised by the caller
 * against whatever the largest row is.
 */
export function barRow(label: string, value: string, pct: number): string {
  const width = Math.max(2, Math.min(100, Math.round(pct)));
  return `<tr>
    <td style="padding:7px 0 7px 14px;font-size:13px;color:${C.dim};white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis">${label}</td>
    <td style="padding:7px 10px;width:100%">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.line};border-radius:3px">
        <tr><td style="width:${width}%;height:7px;background:${C.accent};border-radius:3px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr>
      </table>
    </td>
    <td style="padding:7px 14px 7px 0;font-size:13px;font-weight:600;color:${C.text};text-align:right;white-space:nowrap">${value}</td>
  </tr>`;
}

/**
 * A call-to-action button.
 *
 * A table with a background colour rather than a styled `<a>`: Outlook renders
 * the anchor's padding inconsistently, and a link that looks like plain text is
 * the difference between a message that converts and one that doesn't.
 */
export function button(label: string, href: string): string {
  // Centred in its own full-width row rather than sitting wherever the previous
  // block left the cursor — on a centred message a left-hugging button is the
  // one element off the page's axis.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" style="background:${C.accentDeep};border-radius:8px;mso-padding-alt:11px 22px">
        <a href="${href}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;line-height:1;color:#ffffff !important;text-decoration:none !important;letter-spacing:-0.1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${label}</a>
      </td>
    </tr></table>
  </td></tr></table>`;
}

/**
 * Why this message arrived.
 *
 * No longer rendered — the fine print under the card was cut deliberately. The
 * parameter stays because callers pass a reason that is true of their specific
 * audience, and the one place it still has to appear is a list mail: the
 * scheduled report puts its unsubscribe link in this string, and mail to people
 * who never signed up needs a visible way out or it gets reported.
 *
 * `shell` therefore still renders it when a caller passes one, and shows
 * nothing when they don't.
 */
const DEFAULT_REASON = "";

/**
 * What goes under the card.
 *
 * Both footers carry the Dashboard/Docs/Website row. Dropping it entirely made
 * the transactional mails look unfinished rather than restrained — a message
 * that ends in a line of grey legal text and nothing else reads like it was
 * cut short, and those links are also the cheapest signal that a real product
 * sent this and not someone phishing for a code.
 *
 * What separates them is the sales pitch above the links. "Real-time
 * analytics, SEO audits and a multi-tenant API" belongs on a broadcast or an
 * invitation. On a password reset it is a sentence about a multi-tenant API
 * answering someone who is trying to find out whether their account is
 * compromised.
 */
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
      // Only list mail carries a line under the card now — and it is there to
      // hold an unsubscribe link, not to explain itself. Everything else ends
      // at the card, which is what "quantalog.daorbit.in" repeated under a
      // message already signed Quantalog was adding nothing to.
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

/**
 * The code emails' own shell: branded row, illustrated banner, letter body.
 *
 * Separate from `shell` rather than a flag on it. These two messages are the
 * ones a reader has to trust instantly — a signup code and a password reset —
 * and what earns that is looking like a specific product rather than a generic
 * grey card. Everything else (receipts, broadcasts, reports) is read by someone
 * who already knows who we are, and gains nothing from a header illustration.
 *
 * Left-aligned throughout: this one has a greeting and real sentences, and
 * centred prose stops being readable the moment there is more than a line of it.
 */
/**
 * The face the code emails set in.
 *
 * Inter first for the clients that have it locally, then the platform UI faces,
 * then Helvetica. No webfont: `@font-face` is stripped by most mail clients, so
 * a remote Inter would be a download that buys nothing and a flash of fallback
 * where it half-works.
 */
const FONT = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

function codeShell(inner: string, tagline: string[] = ["Secure", "Private", "Insightful"]): string {
  const banner = bannerAttachment();

  // No card: the message sits straight on the page. The border and radius were
  // drawing a box around a message that is already the only thing on screen.
  //
  // The page itself carries a warm wash that picks up where the banner's own
  // gradient stops, so the illustration reads as part of the message rather
  // than a sticker on white. `background-color` is set first as the fallback:
  // Outlook's Word engine drops `background-image` entirely, and a gradient
  // with no flat colour behind it would fail to the client's default white.
  return `<div style="background-color:${O.washTop};background-image:linear-gradient(180deg,${O.washTop} 0%,${C.card} 260px);padding:28px 16px;font-family:${FONT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto">
    <tr><td style="padding:0">

      <!-- Wordmark left, the three-word promise right. -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px">
        <tr>
          <td style="vertical-align:middle">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding-right:8px;vertical-align:middle">${LOGO_IMG}</td>
              <td style="vertical-align:middle;font-size:19px;font-weight:700;color:${C.text};letter-spacing:-0.4px">Quantalog</td>
            </tr></table>
          </td>
          <td align="right" style="vertical-align:middle;font-size:12px;color:${C.faint};white-space:nowrap">
            ${tagline.join(`<span style="color:${C.line}"> &nbsp;·&nbsp; </span>`)}
          </td>
        </tr>
      </table>

      ${
        banner
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px">
        <tr><td style="font-size:0;line-height:0">
          <img src="cid:${BANNER_CID}" width="600" alt=""
            style="display:block;border:0;outline:none;text-decoration:none;width:100%;max-width:600px;height:auto;border-radius:10px">
        </td></tr>
      </table>`
          : ""
      }

      ${inner}

      <div style="margin-top:22px;padding-top:16px;border-top:1px solid ${C.line}">
        <p style="margin:0;font-size:12.5px;line-height:1.6">
          <a href="${LINKS.app}" style="color:${O.accentDeep};text-decoration:none;font-weight:600">Dashboard</a>
          <span style="color:${C.line}"> &nbsp;·&nbsp; </span>
          <a href="${LINKS.docs}" style="color:${O.accentDeep};text-decoration:none;font-weight:600">Docs</a>
          <span style="color:${C.line}"> &nbsp;·&nbsp; </span>
          <a href="${LINKS.site}" style="color:${O.accentDeep};text-decoration:none;font-weight:600">Website</a>
        </p>
      </div>
    </td></tr>
  </table>
</div>`;
}

/**
 * The code itself, in the banner's warm tint.
 *
 * Digits are spaced with padding on each character rather than
 * `letter-spacing`, which pads the right edge too and pushes the group off
 * centre. 28px is large enough to read off a phone held next to a laptop, which
 * is the actual usage.
 *
 * The block hugs its content instead of filling the width: a full-width bar
 * around six characters reads as an empty input field waiting to be typed into.
 */
function codeBox(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0">
    <!-- White with a warm edge, not the tint: the page behind it is now warm
         too, and a tinted block on a tinted page had no edge at all. -->
    <tr><td align="center" style="background:${C.card};border:1px solid ${O.tint};border-radius:10px;padding:16px 22px">
      <div style="font-size:28px;font-weight:700;line-height:1.2;color:${C.text};white-space:nowrap;font-family:${FONT}">${code
        .split("")
        .map((ch) => `<span style="padding:0 3px">${escapeHtml(ch)}</span>`)
        .join("")}</div>
    </td></tr>
  </table>`;
}

/** When the code dies. Plain small type — a drawn clock icon was decoration. */
function expiryLine(minutes: number): string {
  return `<p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:${C.faint}">This code expires in ${minutes} minutes.</p>`;
}

/** A left-aligned body paragraph, at the size the code emails set prose. */
function codeParagraph(html: string, top: number = 10): string {
  return `<p style="margin:${top}px 0 0;font-size:14.5px;line-height:1.65;color:${C.dim}">${html}</p>`;
}

/**
 * The signup code.
 *
 * Short and in order: who it's for, what was asked for, the code, when it dies,
 * and the one caveat. Someone reads this with the signup page still open in
 * another window, so nothing is above the code that isn't needed to trust it.
 */
export function otpHtml(code: string, minutes: number, name?: string): string {
  return codeShell(
    // No heading: the banner already says "Your verification code is waiting",
    // and repeating it in text underneath was the same sentence twice in two
    // sizes.
    `${codeParagraph(`Hello${name ? ` ${escapeHtml(name)}` : ""},`, 0)}
     ${codeParagraph("We received a request to verify your Quantalog account. Here is your one-time password (OTP):")}

     ${codeBox(code)}
     ${expiryLine(minutes)}

     ${codeParagraph(
       `If you didn't request this, you can safely ignore this email. No account has been created.`,
       18,
     )}
     ${/* No leading em dash: Gmail reads "-- " and "— Name" as a signature
          delimiter and collapses everything from there into a "..." stub, which
          hid the closing line and the footer links. */ ""}
     ${codeParagraph(`The Quantalog Team`, 10)}`,
  );
}

/**
 * The password reset code.
 *
 * Same shape as the signup code, different reassurance: the line that matters
 * here is that the password has not changed, which is the whole reason someone
 * reads a reset email they did not ask for.
 */
export function resetHtml(code: string, minutes: number, name?: string): string {
  return codeShell(
    `${codeParagraph(`Hello${name ? ` ${escapeHtml(name)}` : ""},`, 0)}
     ${codeParagraph("We received a request to reset the password on your Quantalog account. Here is your one-time password (OTP):")}

     ${codeBox(code)}
     ${expiryLine(minutes)}

     ${codeParagraph(
       "If you didn't ask to reset your password, ignore this email. Your password has not changed, and nobody can change it without this code.",
       18,
     )}
     ${codeParagraph(`The Quantalog Team`, 10)}`,
  );
}

/**
 * The after-the-fact notification.
 *
 * Deliberately blunt and deliberately actionable: whoever reads this and did
 * not expect it has minutes, not days, and burying the instruction under
 * reassurance would waste them.
 */
export function passwordChangedHtml(): string {
  return shell(
    `${heading("Your password was changed")}
     ${paragraph(
       "The password on your Quantalog account was just changed. If that was you, there is nothing to do.",
     )}

     <!-- The warning carries a red left edge rather than a full red panel. A
          message that turns out to be routine — which most of these are, since
          this goes out on every successful reset — should not open by shouting;
          but the one reader for whom it is not routine has to find this
          paragraph immediately, and a coloured edge does that without making
          the other ninety-nine feel attacked. -->
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.section}px 0 0">
       <tr>
         <td width="3" style="background:${C.danger};border-radius:3px 0 0 3px;font-size:0;line-height:0">&nbsp;</td>
         <td class="panel" style="background:${C.panel};border-radius:0 10px 10px 0;padding:16px 20px;text-align:left">
           <p style="margin:0;font-size:14.5px;line-height:1.7;color:${C.dim}">
             <strong style="color:${C.text}">If it wasn't you</strong>, someone else may have
             access to your account. Reset your password again straight away, and check that
             your email account is still secure.
           </p>
         </td>
       </tr>
     </table>

     ${button("Reset your password", `${LINKS.app}/forgot-password`)}`,
    undefined,
    "minimal",
  );
}

/**
 * An admin-composed message, in the same shell as everything else.
 *
 * The author writes plain text; this only escapes it and turns blank lines into
 * paragraphs. Inventing headings or buttons the author didn't write would put
 * words in their mouth, so the layout stays out of the way — the branding is
 * the shell, not the message.
 */
export function broadcastHtml(text: string, cta?: { label: string; href: string }): string {
  const blocks = escapeHtml(text).split(/\n{2,}/);

  const paragraphs = blocks
    .map((block, i) => {
      const html = block.replace(/\n/g, "<br>");
      // The opening line carries the greeting, so it gets the emphasis a
      // heading would — without inventing a heading the author didn't write.
      const style =
        i === 0
          ? `margin:0 0 ${S.block}px;font-size:15.5px;font-weight:600;color:${C.text};line-height:1.6`
          : `margin:0 0 ${S.block}px;${T.body}`;
      return `<p style="${style}">${html}</p>`;
    })
    .join("");

  // Only render a button for an http(s) target — an admin-supplied `javascript:`
  // or `data:` href would be a scripting vector in whatever client opens it.
  const action =
    cta && /^https?:\/\//i.test(cta.href)
      ? button(escapeHtml(cta.label), escapeAttr(cta.href))
      : "";

  return shell(paragraphs + action);
}

/**
 * A block of code, for a message whose whole point is the code.
 *
 * The install reminder used to describe the snippet and link to the dashboard
 * to go and find it — which is the one extra step the reader has already failed
 * to take. Putting the actual tag in the message means the fix is copy, paste,
 * done, without leaving the inbox.
 *
 * `word-break` matters more here than anywhere else: a script tag is one long
 * unbreakable token, and without it the block sets the width of the whole card
 * on a phone.
 */
export function codeBlock(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${S.block}px 0 0">
    <tr><td class="panel" style="background:${C.panel};border-radius:10px;padding:16px 18px">
      <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;color:${C.text};word-break:break-all">${escapeHtml(code)}</code>
    </td></tr>
  </table>`;
}

/**
 * A numbered step.
 *
 * Only for messages that really are a sequence — "paste this, then check that".
 * Numbering a list of features would be decoration; numbering the two things
 * standing between someone and working analytics is information they need in
 * order.
 */
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

/**
 * Which body layout a template renders with.
 *
 * "plain" is the default and stays out of the way — it is what an admin writing
 * their own message gets, where inventing structure would put words in their
 * mouth.
 *
 * The rest are for the canned templates, where the message is always about the
 * same thing and prose alone was doing that thing badly. An install reminder
 * that only describes the snippet, or a feature announcement that only asserts
 * a feature exists, is a paragraph asking the reader to go and find something —
 * which, for a template sent to people who already didn't, is the whole problem.
 */
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
      return inviteHtml(text, cta);
    case "install":
      return installHtml(text, cta);
    case "welcome":
      return welcomeHtml(text, cta);
    case "feature":
      return featureHtml(text, cta);
    default:
      return broadcastHtml(text, cta);
  }
}

/**
 * Renders the author's own opening paragraphs.
 *
 * Shared by every designed layout: each one is "the admin's words, then
 * something built". The first block carries the greeting and gets a heading's
 * weight without being marked up as one the author didn't write.
 */
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

/**
 * The install reminder.
 *
 * Sent to someone who added a site and never fired an event, so the one thing
 * standing between them and working analytics is a script tag they haven't
 * pasted. The old version described that tag and linked to the dashboard to go
 * and find it — an extra step for a reader who has already demonstrated they
 * won't take it.
 *
 * So the snippet is in the message. `{{siteId}}` is left as a placeholder
 * because the composer sends one message per recipient and does not currently
 * resolve a per-site value; the shape is right either way, and the reader
 * recognises their own id.
 */
function installHtml(text: string, cta: { label: string; href: string }): string {
  return shell(
    `${intro(text)}

    ${codeBlock('<script async src="https://cdn.quantalog.daorbit.in/q.js" data-site="YOUR-SITE-ID"></script>')}

    ${steps([
      step(1, "Paste it before &lt;/head&gt;", "Anywhere in the head works. One line, on every page you want counted."),
      step(2, "Load any page", "The first pageview lands within a few seconds — no waiting for a nightly job."),
    ])}

    ${button(escapeHtml(cta.label), escapeAttr(cta.href))}`,
  );
}

/**
 * The welcome, for someone who signed up and never added a site.
 *
 * Their blocker is not motivation — they already signed up — it is not knowing
 * how long this is going to take. So the body is the three steps, with the
 * honest scale of each, rather than another pitch for a product they have
 * already chosen.
 */
function welcomeHtml(text: string, cta: { label: string; href: string }): string {
  return shell(
    `${intro(text)}

    ${steps([
      step(1, "Add your site", "Name and domain. Takes about ten seconds."),
      step(2, "Copy the snippet", "One script tag, generated for that site."),
      step(3, "Watch it arrive", "Traffic shows up live, with no sampling and no cookie banner."),
    ])}

    ${button(escapeHtml(cta.label), escapeAttr(cta.href))}`,
  );
}

/**
 * A feature announcement — currently the SEO audit one.
 *
 * Goes to active users, so it cannot open by explaining what Quantalog is. What
 * it has to answer is "what would I get out of running one", and a list of what
 * an audit actually checks does that better than a sentence claiming audits are
 * useful.
 */
function featureHtml(text: string, cta: { label: string; href: string }): string {
  const checks = [
    "Meta tags and canonical URLs",
    "Core Web Vitals from real visitors",
    "Broken links and redirect chains",
    "Structured data and sitemap health",
  ];

  return shell(
    `${intro(text)}

    ${label("What an audit checks")}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${checks
        .map(
          (c) => `<tr>
        <td width="18" style="padding:0 0 10px;vertical-align:top">
          <div style="width:6px;height:6px;border-radius:50%;background:${C.accent};margin-top:7px"></div>
        </td>
        <td style="padding:0 0 10px;vertical-align:top">
          <p style="margin:0;font-size:13.5px;line-height:1.6;color:${C.dim}">${c}</p>
        </td>
      </tr>`,
        )
        .join("")}
    </table>

    ${button(escapeHtml(cta.label), escapeAttr(cta.href))}`,
  );
}

/**
 * The features an invite leads with.
 *
 * Condensed from the landing page's feature grid so the two cannot drift into
 * saying different things. Six rather than nine: an invite is a first
 * impression, and the tail of a nine-item list is read by nobody.
 */
const INVITE_FEATURES: { title: string; body: string }[] = [
  {
    title: "Live in 3 seconds",
    body: "Visitors, pageviews and active sessions stream in as they happen — no overnight batch, no sampling.",
  },
  {
    title: "Cookieless by design",
    body: "Visitors are a rotating daily hash. Nothing persists in the browser, so no consent banner is required.",
  },
  {
    title: "Sub-kilobyte tracker",
    body: "One async script tag. React and Next route changes report themselves with zero extra code.",
  },
  {
    title: "SEO audits built in",
    body: "Lighthouse-backed audits on any page you track: meta tags, structured data, broken links, Core Web Vitals.",
  },
  {
    title: "Dashboards you can share",
    body: "Publish a read-only view at a link anyone can open. You choose which panels are visible.",
  },
  {
    title: "An API, not just a UI",
    body: "Every number in the dashboard is reachable over REST with an API key. Build your own views, or resell them.",
  },
];

/**
 * A feature as a table row.
 *
 * An emerald dot rather than an icon font or an image per feature: six more
 * CID attachments would bloat every invite, and icon fonts do not render in
 * most mail clients.
 */
function featureRow({ title, body }: { title: string; body: string }): string {
  return `<tr>
    <td style="padding:0 0 18px;vertical-align:top;width:18px">
      <div style="width:7px;height:7px;border-radius:50%;background:${C.accent};margin-top:6px"></div>
    </td>
    <td style="padding:0 0 18px;vertical-align:top">
      <p style="margin:0;font-size:14px;font-weight:600;color:${C.text};letter-spacing:-0.1px">${escapeHtml(title)}</p>
      <p style="margin:4px 0 0;font-size:13px;line-height:1.6;color:${C.dim}">${escapeHtml(body)}</p>
    </td>
  </tr>`;
}

/**
 * The invitation: what Quantalog is, what it does, and one button.
 *
 * This is the one message with a designed body rather than an admin's plain
 * text. It goes to people who have never heard of the product, where a wall of
 * prose is deleted unread and a feature list they can skim is not — so the
 * layout is doing real work here, unlike in `broadcastHtml` where it would only
 * be putting words in the author's mouth.
 *
 * `intro` is the admin's own opening, kept editable so an invite can be
 * addressed to a specific person or context; everything below it is fixed.
 */
export function inviteHtml(
  intro: string,
  cta: { label: string; href: string }
): string {
  const paragraphs = escapeHtml(intro)
    .split(/\n{2,}/)
    .map((block, i) => {
      const html = block.replace(/\n/g, "<br>");
      const style =
        i === 0
          ? `margin:0 0 14px;font-size:16px;font-weight:600;color:${C.text};line-height:1.55;letter-spacing:-0.2px`
          : `margin:0 0 14px;${T.body}`;
      return `<p style="${style}">${html}</p>`;
    })
    .join("");

  const action = /^https?:\/\//i.test(cta.href)
    ? button(escapeHtml(cta.label), escapeAttr(cta.href))
    : "";

  return shell(
    `${paragraphs}

    <div style="margin:${S.section}px 0;height:1px;background:${C.line}"></div>

    <p style="margin:0 0 ${S.block}px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint}">
      What you get
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${INVITE_FEATURES.map(featureRow).join("")}
    </table>

    <!-- The caveats sit above the button, not below it. A paragraph after the
         call to action competes with the one thing this message is asking for,
         and the demo link in particular is an invitation to not sign up. -->
    <p style="margin:6px 0 0;font-size:13.5px;line-height:1.65;color:${C.dim}">
      Free to start, and the tracker is one line — or try the
      <a href="${escapeAttr(LINKS.site)}" style="color:${C.accent};text-decoration:none;font-weight:600">live demo</a>
      first, which needs no account at all.
    </p>

    ${action}`,
    // These people do not have an account, so the default footer line would be
    // untrue — and untrue fine print on a cold email is how a domain gets
    // flagged.
    "You received this because someone thought Quantalog would be useful to you."
  );
}

/** Escape a URL for use inside a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The same markup, but viewable in a browser.
 *
 * A `cid:` reference only resolves against the MIME parts of a delivered
 * message, so the admin preview would show a broken image for the one element
 * that is guaranteed to be fine in the real thing. Swapping in the data URI
 * keeps the preview honest about everything else.
 */
export function forBrowser(html: string): string {
  return html.replace(`cid:${LOGO_CID}`, LOGO_DATA_URI);
}

/* ----------------------------- contact form ------------------------------- */

/**
 * Sent to whoever fills in the contact form, immediately.
 *
 * The point is to close the loop: a form that swallows a message and says
 * nothing leaves the sender wondering whether it arrived, and the usual next
 * move is to send it again. Quoting their own message back is what makes it
 * read as a receipt rather than an autoresponder.
 *
 * The footer reason is overridden because the default one claims the recipient
 * has an account — the whole premise of this form is that they may not.
 */
export function contactAckHtml(name: string, subject: string, message: string): string {
  const quoted = escapeHtml(message).replace(/\n/g, "<br>");

  // Left-aligned, unlike the code mails: this one has real prose and a quoted
  // block, and centred paragraphs stop being readable past a couple of lines
  // because every line starts somewhere different.
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

/* -------------------------------- receipts -------------------------------- */

/**
 * The payment receipt, sent once a purchase is credited.
 *
 * The PDF rides along as an attachment rather than being left behind a link:
 * the common reason someone wants this document is to hand it to an accountant
 * or file an expense, and a login wall between them and the file is friction at
 * exactly the wrong moment. The dashboard link is still offered for the copy
 * they'll want in six months, when the email is buried.
 *
 * Amounts arrive pre-formatted — the caller owns the smallest-unit division, so
 * the template can't get it wrong on its own.
 */
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

  await sendOne(
    to,
    `Receipt ${invoice.number} — payment received`,
    text,
    invoiceHtml(invoice),
    [
      {
        filename: `${invoice.number}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
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

/* ------------------------------ newsletter -------------------------------- */

/**
 * Sent when someone subscribes from the marketing site.
 *
 * Deliberately short. The visitor gave one field and expects one thing back —
 * confirmation that it worked — so anything beyond that is a cold email to
 * someone who has not agreed to one yet.
 *
 * The footer reason is overridden for the same reason the contact receipt
 * overrides it: a subscriber has no account, and the default line would say
 * they do.
 */
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

/**
 * An invitation to join a workspace.
 *
 * The workspace name and who sent it carry the whole message: an invite that
 * doesn't say what you're joining or who asked reads as phishing, which is
 * exactly how a legitimate one gets deleted.
 */
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

  await sendOne(
    to,
    `${invite.inviterName} invited you to ${invite.workspaceName} on Quantalog`,
    text,
    workspaceInviteHtml(invite, link, roleLine, what),
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

  await sendOne(
    to,
    `Your ${info.planName} plan ends ${when}`,
    text,
    planExpiryHtml(info, link, when, endsOn),
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
