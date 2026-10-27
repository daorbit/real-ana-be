import { C } from "../../infra/mail/mailer.js";
import { escapeHtml } from "../../infra/mail/templates/shared.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 5;
const MAX_PDF_CHARS = 8_000_000;
const LINK = /^https?:\/\/[^\s"'<>]+$/;

export interface DocumentEmail {
  to: string[];
  cc: string[];
  subject: string;
  message: string;
  replyTo: string;
  senderName: string;
  document: {
    label: string;
    number: string;
    amount: string;
    amountLabel: string;
    dueText: string;
    link: string;
  };
  pdf: { filename: string; content: Buffer } | null;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => str(entry, 200))
    .filter((entry) => EMAIL.test(entry))
    .slice(0, MAX_RECIPIENTS);
}

function pdfOf(value: unknown): DocumentEmail["pdf"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!content || content.length > MAX_PDF_CHARS) return null;
  const filename = str(raw.filename, 120).replace(/[^\w.\- ]/g, "") || "document.pdf";
  return { filename: filename.endsWith(".pdf") ? filename : `${filename}.pdf`, content: Buffer.from(content, "base64") };
}

export function readDocumentEmail(body: unknown): DocumentEmail | null {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const doc = (raw.document && typeof raw.document === "object" ? raw.document : {}) as Record<string, unknown>;
  const to = addresses(raw.to);
  const subject = str(raw.subject, 200);
  const link = str(doc.link, 500);
  if (!to.length || !subject || !LINK.test(link)) return null;

  const replyTo = str(raw.replyTo, 200);
  return {
    to,
    cc: addresses(raw.cc),
    subject,
    message: str(raw.message, 5000),
    replyTo: EMAIL.test(replyTo) ? replyTo : "",
    senderName: str(raw.senderName, 120) || "Your supplier",
    document: {
      label: str(doc.label, 40) || "Document",
      number: str(doc.number, 64),
      amount: str(doc.amount, 60),
      amountLabel: str(doc.amountLabel, 40),
      dueText: str(doc.dueText, 80),
      link,
    },
    pdf: pdfOf(raw.pdf),
  };
}

function row(label: string, value: string, strong = false): string {
  if (!value) return "";
  return `<tr>
    <td style="padding:7px 0;font-size:13px;color:${C.faint};white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:7px 0;font-size:${strong ? "16px" : "13px"};font-weight:${strong ? "700" : "500"};color:${C.text};text-align:right">${escapeHtml(value)}</td>
  </tr>`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:${C.dim}">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

export function documentEmailHtml(email: DocumentEmail, logoCid: string): string {
  const { document: doc } = email;
  const sender = escapeHtml(email.senderName);
  const action = `View ${escapeHtml(doc.label.toLowerCase())}`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
</head><body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page}">
<div style="background:${C.page};padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto">
    <tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:32px">
      <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:${C.faint}">${sender}</p>
      <p style="margin:0 0 20px;font-size:20px;font-weight:700;letter-spacing:-0.3px;color:${C.text}">${escapeHtml(doc.label)} ${escapeHtml(doc.number)}</p>
      ${paragraphs(email.message)}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 0">
        <tr><td style="background:${C.panel};border-radius:10px;padding:16px 20px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${row(doc.amountLabel || "Amount", doc.amount, true)}
            ${row("Due", doc.dueText.replace(/^(Due|Valid until)\s*/, ""))}
          </table>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0"><tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" style="background:${C.text};border-radius:8px">
            <a href="${escapeHtml(doc.link)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;line-height:1;color:#ffffff !important;text-decoration:none !important">${action}</a>
          </td>
        </tr></table>
      </td></tr></table>
      ${email.pdf ? `<p style="margin:18px 0 0;font-size:12.5px;line-height:1.6;color:${C.faint};text-align:center">The PDF is attached to this email.</p>` : ""}
    </td></tr>
    <tr><td style="padding:20px 8px 0;text-align:center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr>
        <td style="padding-right:7px;vertical-align:middle"><img src="cid:${logoCid}" width="16" height="16" alt="" style="display:block;border:0;width:16px;height:16px"></td>
        <td style="vertical-align:middle;font-size:11.5px;color:${C.faint}">Sent by ${sender} with Quantalog Invoicing. Reply to reach ${sender}.</td>
      </tr></table>
    </td></tr>
  </table>
</div>
</body></html>`;
}

export function documentEmailText(email: DocumentEmail): string {
  const { document: doc } = email;
  return [
    `${doc.label} ${doc.number} from ${email.senderName}`,
    "",
    email.message,
    "",
    [doc.amountLabel, doc.amount].filter(Boolean).join(": "),
    doc.dueText,
    "",
    `View it online: ${doc.link}`,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}
