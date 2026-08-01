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
import { LOGO_DATA_URI } from "./logo.js";

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
  cta?: { label: string; href: string },
  /**
   * Which body layout to render.
   *
   * "invite" swaps the plain-text renderer for the designed feature list, for
   * the one template that goes to people who have never heard of the product.
   */
  layout: "plain" | "invite" = "plain",
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
        // The invite layout needs a button to be worth sending — its whole
        // purpose is getting someone to the signup page — so it falls back to
        // the plain renderer rather than shipping a feature list with no way in.
        html:
          layout === "invite" && cta
            ? inviteHtml(text, cta)
            : broadcastHtml(text, cta),
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
  attachments: { filename: string; content: Buffer; contentType?: string }[] = [],
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

  await sendOne(to, `${code} is your Quantalog verification code`, text, otpHtml(code, minutes));
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

const LOGO_IMG = `<img src="cid:${LOGO_CID}" width="36" height="36" alt="Quantalog"
  style="display:block;border:0;outline:none;text-decoration:none;width:36px;height:36px">`;

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
 * Text colours are deliberately brighter than a browser design would need. Some
 * clients — Outlook's Word engine most reliably — discard background colours
 * while keeping text colours, so any text that depends on a dark card behind it
 * to be readable becomes invisible. Every foreground here is chosen to survive
 * being dropped onto white.
 */
export const C = {
  page: "#0b0c0f",
  card: "#16181d",
  panel: "#1b1e24",
  line: "#2a2e36",
  text: "#f3f4f6",
  /** Body copy. Passes on the dark card, still legible if a client strips it. */
  dim: "#9aa1ad",
  faint: "#6b7280",
  accent: "#10b981",
  accentDeep: "#047857",
  danger: "#f87171",
} as const;

/**
 * A labelled number.
 *
 * Laid out as a table cell rather than a flex child: this is the piece most
 * likely to end up in a grid, and Outlook supports neither flex nor grid.
 */
export function statTile(label: string, value: string, delta?: string, tone: "up" | "down" | "flat" = "flat"): string {
  const toneColor = tone === "up" ? C.accent : tone === "down" ? C.danger : C.faint;
  return `<td width="50%" class="panel" style="padding:14px 16px;background:${C.panel};border:1px solid ${C.line};border-radius:10px;vertical-align:top">
    <div style="font-size:11px;letter-spacing:0.8px;text-transform:uppercase;color:${C.faint};font-weight:600">${label}</div>
    <div style="font-size:24px;font-weight:700;color:${C.text};line-height:1.3;padding-top:2px">${value}</div>
    ${delta ? `<div style="font-size:12px;font-weight:600;color:${toneColor}">${delta}</div>` : ""}
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
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0"><tr>
    <td align="center" style="background:#047857;border-radius:9px;mso-padding-alt:14px 28px">
      <a href="${href}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;line-height:1;color:#ffffff !important;text-decoration:none !important;letter-spacing:-0.1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${label}</a>
    </td>
  </tr></table>`;
}

/**
 * Why this message arrived, in the footer's fine print.
 *
 * An invite goes to someone who does not have an account, so the default line
 * would be a plain falsehood — and "you're receiving this because you have an
 * account" on a cold email is exactly the kind of thing that gets a sender
 * marked as spam. Callers sending to non-users pass their own reason.
 */
const DEFAULT_REASON = "You're receiving this because you have a Quantalog account.";

export function shell(inner: string, reason: string = DEFAULT_REASON): string {
  return `<div style="background:#0b0c0f;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <!--[if mso]>
  <style>
    /* Outlook's Word engine drops border-radius and renders every background
       it does keep without antialiasing, so rounded cards come out as square
       boxes with ragged edges. Squaring them deliberately looks intentional;
       leaving them to Word does not. */
    .card, .panel { border-radius: 0 !important; }
  </style>
  <![endif]-->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto">

    <!-- Header. Kept dark rather than an emerald band: the logo tile is itself
         an emerald gradient, and on a green background the tile vanishes and
         only the white glyph reads — which is not the app's mark. -->
    <tr><td style="background:#131519;border:1px solid #22252c;border-bottom:none;border-radius:16px 16px 0 0;padding:24px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:10px;vertical-align:middle">${LOGO_IMG}</td>
        <td style="vertical-align:middle;font-size:19px;font-weight:700;color:#f3f4f6;letter-spacing:-0.3px">Quantalog<span style="color:#10b981">.</span></td>
      </tr></table>
    </td></tr>

    <tr><td style="background:#16181d;border-left:1px solid #22252c;border-right:1px solid #22252c;padding:30px 32px 32px">
      ${inner}
    </td></tr>

    <!-- Footer: product links, then the legal line. -->
    <tr><td style="background:#131519;border:1px solid #22252c;border-top:none;border-radius:0 0 16px 16px;padding:20px 32px">
      <p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#9aa1ad">
        Real-time analytics, SEO audits and a multi-tenant API — from one script tag.
      </p>
      <p style="margin:0;font-size:13px">
        <a href="${LINKS.app}" style="color:#34d399;text-decoration:none;font-weight:500">Dashboard</a>
        <span style="color:#3a3f4a"> &nbsp;·&nbsp; </span>
        <a href="${LINKS.docs}" style="color:#34d399;text-decoration:none;font-weight:500">Docs</a>
        <span style="color:#3a3f4a"> &nbsp;·&nbsp; </span>
        <a href="${LINKS.site}" style="color:#34d399;text-decoration:none;font-weight:500">Website</a>
      </p>
    </td></tr>

    <tr><td style="padding:18px 8px 0;text-align:center">
      <p style="margin:0;font-size:11px;line-height:1.7;color:#6b7280">
        ${reason}<br>
        <a href="${LINKS.site}" style="color:#6b7280;text-decoration:underline">quantalog.daorbit.in</a>
      </p>
    </td></tr>
  </table>
</div>`;
}

function otpHtml(code: string, minutes: number): string {
  return shell(`
      <p style="margin:0;font-size:20px;font-weight:700;color:${C.text};letter-spacing:-0.3px;text-align:center">Verify your account</p>
      <p style="margin:8px 0 0;font-size:14px;line-height:1.65;color:${C.dim};text-align:center">
        Enter this code on the signup page to finish creating your account.
      </p>

      <!-- The code panel is the whole point of this email, so it gets the only
           accent border in the shell and nothing else competes for attention. -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0">
        <tr><td class="panel" style="background:${C.panel};border:1px solid ${C.accentDeep};border-radius:12px;padding:24px;text-align:center">
          <div style="font-size:36px;font-weight:700;letter-spacing:12px;text-indent:12px;color:${C.accent};font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace">${code}</div>
          <div style="margin-top:12px;font-size:12px;color:${C.faint}">Valid for ${minutes} minutes</div>
        </td></tr>
      </table>

      <div style="margin-top:24px;padding-top:20px;border-top:1px solid ${C.line}">
        <p style="margin:0;font-size:12.5px;line-height:1.65;color:${C.faint};text-align:center">
          If you didn't request this code, you can safely ignore this email —
          no account has been created.
        </p>
      </div>`);
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
          ? "margin:0 0 16px;font-size:16px;font-weight:600;color:#f3f4f6;line-height:1.6"
          : "margin:0 0 16px;font-size:15px;line-height:1.7;color:#9aa1ad";
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
      <div style="width:7px;height:7px;border-radius:50%;background:#10b981;margin-top:6px"></div>
    </td>
    <td style="padding:0 0 18px;vertical-align:top">
      <p style="margin:0;font-size:14px;font-weight:600;color:#e8eaee;letter-spacing:-0.1px">${escapeHtml(title)}</p>
      <p style="margin:4px 0 0;font-size:13px;line-height:1.6;color:#9aa1ad">${escapeHtml(body)}</p>
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
          ? "margin:0 0 14px;font-size:17px;font-weight:600;color:#f3f4f6;line-height:1.55;letter-spacing:-0.2px"
          : "margin:0 0 14px;font-size:15px;line-height:1.7;color:#9aa1ad";
      return `<p style="${style}">${html}</p>`;
    })
    .join("");

  const action = /^https?:\/\//i.test(cta.href)
    ? button(escapeHtml(cta.label), escapeAttr(cta.href))
    : "";

  return shell(
    `${paragraphs}

    <div style="margin:24px 0 22px;height:1px;background:#22252c"></div>

    <p style="margin:0 0 16px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#6b7280">
      What you get
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      ${INVITE_FEATURES.map(featureRow).join("")}
    </table>

    <!-- The caveats sit above the button, not below it. A paragraph after the
         call to action competes with the one thing this message is asking for,
         and the demo link in particular is an invitation to not sign up. -->
    <p style="margin:6px 0 0;font-size:13px;line-height:1.65;color:#9aa1ad">
      Free to start, and the tracker is one line — or try the
      <a href="${escapeAttr(LINKS.site)}" style="color:#34d399;text-decoration:none;font-weight:500">live demo</a>
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
