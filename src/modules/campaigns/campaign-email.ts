import { C } from "../../infra/mail/mailer.js";
import { escapeHtml } from "../../infra/mail/templates/shared.js";
import type { PublicBrand } from "../branding/public-brand.js";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const URL_IN_TEXT = /(https?:\/\/[^\s<]+)/g;
const NAME_TOKEN = /\{\{\s*name\s*\}\}/g;
const FALLBACK_NAME = "there";

export interface CampaignContent {
  subject: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  senderAddress: string;
}

export interface CampaignRecipientInfo {
  name?: string;
  unsubscribeUrl: string;
}

function personalize(text: string, name?: string): string {
  return text.replace(NAME_TOKEN, name?.trim() || FALLBACK_NAME);
}

function linkify(escaped: string): string {
  return escaped.replace(URL_IN_TEXT, (url) => `<a href="${url}" style="color:${C.text};text-decoration:underline">${url}</a>`);
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${C.dim}">${linkify(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

function button(label: string, href: string, accent: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0"><tr>
    <td align="center" style="background:${accent};border-radius:8px">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;line-height:1;color:#ffffff !important;text-decoration:none !important">${escapeHtml(label)}</a>
    </td>
  </tr></table>`;
}

function brandHeader(brand: PublicBrand, workspaceName: string): string {
  const logo = brand.logoUrl
    ? `<td style="padding-right:10px;vertical-align:middle"><img src="${escapeHtml(brand.logoUrl)}" width="26" height="26" alt="" style="display:block;border:0;width:26px;height:26px;border-radius:6px"></td>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px"><tr>
    ${logo}
    <td style="vertical-align:middle;font-size:16px;font-weight:700;color:${C.text}">${escapeHtml(brand.name || workspaceName)}</td>
  </tr></table>`;
}

export function campaignHtml(
  content: CampaignContent,
  recipient: CampaignRecipientInfo,
  brand: PublicBrand,
  workspaceName: string,
): string {
  const sender = brand.name || workspaceName;
  const accent = brand.accentColor || C.text;
  const action = content.ctaLabel && content.ctaUrl ? button(content.ctaLabel, content.ctaUrl, accent) : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
</head><body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page}">
<div style="background:${C.page};padding:32px 16px;font-family:${FONT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto">
    <tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:32px">
      ${brandHeader(brand, workspaceName)}
      ${paragraphs(personalize(content.body, recipient.name))}
      ${action}
    </td></tr>
    <tr><td style="padding:20px 8px 0;text-align:center;font-size:12px;line-height:1.6;color:${C.faint}">
      <p style="margin:0 0 6px">${escapeHtml(sender)} · ${escapeHtml(content.senderAddress)}</p>
      <p style="margin:0"><a href="${escapeHtml(recipient.unsubscribeUrl)}" style="color:${C.faint};text-decoration:underline">Unsubscribe</a> from these emails.</p>
    </td></tr>
  </table>
</div>
</body></html>`;
}

export function campaignText(content: CampaignContent, recipient: CampaignRecipientInfo, sender: string): string {
  return [
    personalize(content.body, recipient.name),
    ...(content.ctaLabel && content.ctaUrl ? ["", `${content.ctaLabel}: ${content.ctaUrl}`] : []),
    "",
    "--",
    `${sender} · ${content.senderAddress}`,
    `Unsubscribe: ${recipient.unsubscribeUrl}`,
  ].join("\n");
}

export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
