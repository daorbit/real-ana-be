import { escapeAttr, escapeHtml } from "../../infra/mail/templates/shared.js";
import type { PublicBrand } from "../branding/public-brand.js";
import { EMAIL_FONTS, type EmailBlock, type EmailDesign, type EmailTheme } from "./campaign-design.js";
import type { CampaignMode } from "./campaign-draft.js";

const URL_IN_TEXT = /(https?:\/\/[^\s<]+)/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const NAME_TOKEN = /\{\{\s*name\s*\}\}/g;
const UNSUBSCRIBE_TOKEN = /\{\{\s*unsubscribe_url\s*\}\}/g;
const FALLBACK_NAME = "there";

const HEADING_SIZE = { s: 20, m: 26, l: 34, xl: 48 } as const;
const TEXT_SIZE = { s: 14, m: 16, l: 19 } as const;

export interface CampaignContent {
  subject: string;
  preheader: string;
  mode: CampaignMode;
  design: EmailDesign;
  html: string;
  senderAddress: string;
}

export interface CampaignRecipientInfo {
  name?: string;
  unsubscribeUrl: string;
}

interface RenderContext {
  theme: EmailTheme;
  brand: PublicBrand;
  sender: string;
  name?: string;
}

function personalize(value: string, name?: string): string {
  return value.replace(NAME_TOKEN, name?.trim() || FALLBACK_NAME);
}

function inlineText(value: string, ctx: RenderContext): string {
  return escapeHtml(personalize(value, ctx.name))
    .replace(BOLD, `<strong style="font-weight:600;color:${ctx.theme.headingColor}">$1</strong>`)
    .replace(URL_IN_TEXT, (url) => `<a href="${escapeAttr(url)}" style="color:${ctx.theme.accentColor};text-decoration:underline">${url}</a>`)
    .replace(/\n/g, "<br>");
}

function paragraphs(value: string, style: string, ctx: RenderContext): string {
  return value
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 14px;${style}">${inlineText(block, ctx)}</p>`)
    .join("");
}

function row(inner: string, padding = "0 0 18px"): string {
  return `<tr><td style="padding:${padding}">${inner}</td></tr>`;
}

function brandBlock(block: Extract<EmailBlock, { type: "brand" }>, ctx: RenderContext): string {
  const logo = ctx.brand.logoUrl
    ? `<img src="${escapeAttr(ctx.brand.logoUrl)}" height="32" alt="${escapeAttr(ctx.sender)}" style="display:inline-block;border:0;height:32px;width:auto">`
    : `<span style="font-size:18px;font-weight:700;letter-spacing:-0.02em;color:${ctx.theme.headingColor}">${escapeHtml(ctx.sender)}</span>`;
  return row(`<div style="text-align:${block.align}">${logo}</div>`, "0 0 28px");
}

function buttonBlock(block: Extract<EmailBlock, { type: "button" }>, ctx: RenderContext): string {
  if (!block.label || !block.url) return "";
  const width = block.fullWidth ? ' width="100%"' : "";
  return row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"${width} align="${block.align}" style="margin:4px 0"><tr>
    <td align="center" bgcolor="${ctx.theme.accentColor}" style="background:${ctx.theme.accentColor};border-radius:12px">
      <a href="${escapeAttr(block.url)}" style="display:block;padding:14px 26px;font-size:16px;font-weight:600;line-height:1.2;color:${ctx.theme.buttonTextColor} !important;text-decoration:none !important">${escapeHtml(personalize(block.label, ctx.name))}</a>
    </td>
  </tr></table>`);
}

function imageBlock(block: Extract<EmailBlock, { type: "image" }>): string {
  if (!block.url) return "";
  const image = `<img src="${escapeAttr(block.url)}" alt="${escapeAttr(block.alt)}" width="${block.width}%" style="display:inline-block;width:${block.width}%;max-width:100%;height:auto;border:0;border-radius:${block.radius}px">`;
  const linked = block.link ? `<a href="${escapeAttr(block.link)}">${image}</a>` : image;
  return row(`<div style="text-align:center">${linked}</div>`);
}

function column(title: string, value: string, ctx: RenderContext): string {
  const heading = title
    ? `<p style="margin:0 0 6px;font-size:16px;font-weight:600;line-height:1.3;color:${ctx.theme.headingColor}">${inlineText(title, ctx)}</p>`
    : "";
  return `${heading}${paragraphs(value, `font-size:14px;line-height:1.55;color:${ctx.theme.textColor}`, ctx)}`;
}

function columnsBlock(block: Extract<EmailBlock, { type: "columns" }>, ctx: RenderContext): string {
  return row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td class="q-col" width="50%" valign="top" style="padding-right:12px">${column(block.leftTitle, block.leftText, ctx)}</td>
    <td class="q-col" width="50%" valign="top" style="padding-left:12px">${column(block.rightTitle, block.rightText, ctx)}</td>
  </tr></table>`);
}

function renderBlock(block: EmailBlock, ctx: RenderContext): string {
  switch (block.type) {
    case "brand":
      return brandBlock(block, ctx);
    case "heading": {
      if (!block.text.trim()) return "";
      const size = HEADING_SIZE[block.size];
      return row(`<h2 style="margin:0;font-size:${size}px;font-weight:700;line-height:1.1;letter-spacing:-0.02em;color:${ctx.theme.headingColor};text-align:${block.align}">${inlineText(block.text, ctx)}</h2>`);
    }
    case "text": {
      const size = TEXT_SIZE[block.size];
      return row(paragraphs(block.text, `font-size:${size}px;line-height:1.55;color:${ctx.theme.textColor};text-align:${block.align}`, ctx), "0 0 6px");
    }
    case "button":
      return buttonBlock(block, ctx);
    case "image":
      return imageBlock(block);
    case "divider":
      return row(`<div style="height:1px;font-size:0;line-height:0;background:${ctx.theme.mutedColor};opacity:0.3">&nbsp;</div>`, "6px 0 22px");
    case "spacer":
      return `<tr><td height="${block.height}" style="height:${block.height}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    case "columns":
      return columnsBlock(block, ctx);
  }
}

function footerHtml(address: string, sender: string, url: string, color: string): string {
  return `<div style="padding:22px 8px 0;font-size:12px;line-height:1.6;text-align:center;color:${color}">
    <p style="margin:0 0 6px">${escapeHtml(sender)} · ${escapeHtml(address)}</p>
    <p style="margin:0"><a href="${escapeAttr(url)}" style="color:${color};text-decoration:underline">Unsubscribe</a> from these emails.</p>
  </div>`;
}

function preheaderHtml(preheader: string, name?: string): string {
  if (!preheader) return "";
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px">${escapeHtml(personalize(preheader, name))}</div>`;
}

function designHtml(content: CampaignContent, recipient: CampaignRecipientInfo, ctx: RenderContext): string {
  const { theme } = ctx;
  const blocks = content.design.blocks.map((block) => renderBlock(block, ctx)).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
@media (max-width:600px){
  .q-card{padding:28px 22px !important}
  .q-col{display:block !important;width:100% !important;padding:0 0 14px !important}
}
</style>
</head><body bgcolor="${theme.pageColor}" style="margin:0;padding:0;background-color:${theme.pageColor}">
${preheaderHtml(content.preheader, recipient.name)}
<div style="background:${theme.pageColor};padding:32px 14px;font-family:${EMAIL_FONTS[theme.font]}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:${theme.width}px;margin:0 auto">
    <tr><td class="q-card" bgcolor="${theme.cardColor}" style="background:${theme.cardColor};border-radius:${theme.radius}px;padding:40px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${blocks}</table>
    </td></tr>
    <tr><td>${footerHtml(content.senderAddress, ctx.sender, recipient.unsubscribeUrl, theme.mutedColor)}</td></tr>
  </table>
</div>
</body></html>`;
}

function customHtml(content: CampaignContent, recipient: CampaignRecipientInfo, sender: string): string {
  const hasUnsubscribe = UNSUBSCRIBE_TOKEN.test(content.html);
  UNSUBSCRIBE_TOKEN.lastIndex = 0;
  const filled = content.html
    .replace(NAME_TOKEN, escapeHtml(recipient.name?.trim() || FALLBACK_NAME))
    .replace(UNSUBSCRIBE_TOKEN, escapeAttr(recipient.unsubscribeUrl));
  if (hasUnsubscribe) return filled;

  const footer = footerHtml(content.senderAddress, sender, recipient.unsubscribeUrl, "#86868b");
  return /<\/body>/i.test(filled) ? filled.replace(/<\/body>/i, `${footer}</body>`) : `${filled}${footer}`;
}

export function campaignHtml(
  content: CampaignContent,
  recipient: CampaignRecipientInfo,
  brand: PublicBrand,
  workspaceName: string,
): string {
  const sender = brand.name || workspaceName;
  if (content.mode === "html") return customHtml(content, recipient, sender);
  return designHtml(content, recipient, { theme: content.design.theme, brand, sender, name: recipient.name });
}

function blockText(block: EmailBlock): string {
  switch (block.type) {
    case "heading":
    case "text":
      return block.text.replace(BOLD, "$1");
    case "button":
      return block.label && block.url ? `${block.label}: ${block.url}` : "";
    case "columns":
      return [block.leftTitle, block.leftText, block.rightTitle, block.rightText].filter(Boolean).join("\n");
    default:
      return "";
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function campaignText(content: CampaignContent, recipient: CampaignRecipientInfo, sender: string): string {
  const main =
    content.mode === "html"
      ? htmlToText(content.html.replace(UNSUBSCRIBE_TOKEN, recipient.unsubscribeUrl))
      : content.design.blocks.map(blockText).filter(Boolean).join("\n\n");
  return [
    personalize(main, recipient.name),
    "",
    "--",
    `${sender} · ${content.senderAddress}`,
    `Unsubscribe: ${recipient.unsubscribeUrl}`,
  ].join("\n");
}

export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
