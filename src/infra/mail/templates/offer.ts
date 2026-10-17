import { actionButton, bannerShell, C, escapeHtml, FONT, line, signOff, small, THEMES, type BannerName } from "./shared.js";

const BANNER: BannerName = "offer";

type ParsedOffer = {
  intro: string;
  outro: string;
  code?: string;
  offer?: string;
  validUntil?: string;
};

const FIELD = /^(code|offer|valid until)\s*:\s*(.+)$/i;

function tidy(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseOffer(text: string): ParsedOffer {
  const parsed: ParsedOffer = { intro: "", outro: "" };
  const before: string[] = [];
  const after: string[] = [];
  let seenField = false;

  for (const raw of text.split("\n")) {
    const match = raw.trim().match(FIELD);
    if (!match) {
      (seenField ? after : before).push(raw);
      continue;
    }
    seenField = true;
    const value = match[2].trim();
    const key = match[1].toLowerCase();
    if (key === "code") parsed.code = value.toUpperCase().replace(/\s+/g, "");
    else if (key === "offer") parsed.offer = value;
    else parsed.validUntil = value;
  }

  parsed.intro = tidy(before);
  parsed.outro = tidy(after);
  return parsed;
}

export function withCoupon(href: string, code?: string): string {
  if (!code) return href;
  try {
    const url = new URL(href);
    url.searchParams.set("coupon", code);
    return url.toString();
  } catch {
    return href;
  }
}

function couponPanel({ code, offer, validUntil }: ParsedOffer): string {
  if (!code) return "";
  const theme = THEMES[BANNER];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0 0">
    <tr><td align="center" bgcolor="${theme.wash}" style="background:${theme.wash};border:1.5px dashed ${theme.accent};border-radius:12px;padding:20px 18px;text-align:center">
      <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${C.faint}"><font color="${C.faint}">Your code</font></p>
      <p style="margin:8px 0 0;font-size:26px;font-weight:800;letter-spacing:3px;line-height:1.2;color:${theme.accentDeep};font-family:${FONT}"><font color="${theme.accentDeep}">${escapeHtml(code)}</font></p>
      ${offer ? `<p style="margin:8px 0 0;font-size:14px;font-weight:600;line-height:1.5;color:${C.text}"><font color="${C.text}">${escapeHtml(offer)}</font></p>` : ""}
      ${validUntil ? `<p style="margin:4px 0 0;font-size:12.5px;line-height:1.5;color:${C.faint}"><font color="${C.faint}">Valid until ${escapeHtml(validUntil)}</font></p>` : ""}
    </td></tr>
  </table>`;
}

function paragraphs(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((block, i) => line(block.replace(/\n/g, "<br>"), i === 0 ? 0 : 10))
    .join("");
}

export function offerHtml(text: string, cta: { label: string; href: string }): string {
  const parsed = parseOffer(text);
  return bannerShell(
    BANNER,
    `${paragraphs(parsed.intro)}
     ${couponPanel(parsed)}
     ${parsed.outro ? `<div style="margin-top:16px">${paragraphs(parsed.outro)}</div>` : ""}
     ${actionButton(cta.label, withCoupon(cta.href, parsed.code), BANNER)}
     ${parsed.code ? small("The code is applied for you at checkout. You can also enter it by hand under Add a coupon code.", 12) : ""}
     ${signOff()}`,
  );
}
