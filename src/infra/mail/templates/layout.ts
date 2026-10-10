import { LINKS, LOGO_ATTACHMENT, escapeHtml } from "./shared.js";

const FONT = `-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif`;

export const P = {
  band: "#3730a3",
  bandText: "#c7d2fe",
  page: "#f4f5f9",
  card: "#ffffff",
  ink: "#1d1d1f",
  body: "#515154",
  muted: "#6e6e73",
  hair: "#e8e8ed",
  brand: "#4338ca",
  brandDeep: "#3730a3",
  pill: "#f0f0ff",
  link: "#4338ca",
} as const;

const logo = (size: number, radius: number, bg = "") =>
  `<img src="cid:${LOGO_ATTACHMENT.cid}" width="${size}" height="${size}" alt="Quantalog" style="display:block;border:0;outline:none;width:${size}px;height:${size}px;border-radius:${radius}px${bg ? `;background:${bg}` : ""}">`;

export function cardLogo(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td>${logo(56, 14)}</td></tr></table>`;
}

export function title(text: string): string {
  return `<h1 style="margin:28px 0 0;font-family:${FONT};font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-0.7px;color:${P.ink};text-align:center">${text}</h1>`;
}

export function text(html: string, top = 14): string {
  return `<p style="margin:${top}px auto 0;max-width:420px;font-family:${FONT};font-size:16px;line-height:1.55;color:${P.body};text-align:center">${html}</p>`;
}

export function strong(value: string): string {
  const safe = escapeHtml(value).replace("@", `<span style="color:${P.ink}">@</span>`).replace(/\./g, `<span style="color:${P.ink}">.</span>`);
  return `<span style="color:${P.ink};font-weight:600;text-decoration:none">${safe}</span>`;
}

export function bigCode(code: string): string {
  return `<p class="q-code" style="margin:36px 0 0;font-family:${FONT};font-size:52px;line-height:1;font-weight:700;letter-spacing:12px;text-indent:12px;color:${P.brand};text-align:center;white-space:nowrap">${escapeHtml(code)}</p>`;
}

export function pill(label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto 0"><tr>
    <td bgcolor="${P.pill}" style="background:${P.pill};border-radius:999px;padding:7px 16px;font-family:${FONT};font-size:13px;line-height:1.2;font-weight:600;color:${P.brandDeep};white-space:nowrap">${label}</td>
  </tr></table>`;
}

export function rule(top = 40): string {
  return `<div style="margin:${top}px 0 0;height:1px;line-height:1px;font-size:0;background:${P.hair}">&nbsp;</div>`;
}

export function fineprint(html: string, top = 28): string {
  return `<p style="margin:${top}px auto 0;max-width:440px;font-family:${FONT};font-size:13.5px;line-height:1.6;color:${P.muted};text-align:center">${html}</p>`;
}

export function layout(opts: { preheader: string; label: string; head: string; body: string; legal: string }): string {
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<meta name="x-apple-disable-message-reformatting">
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  body { background-color:${P.page} !important; }
  @media (max-width:520px) {
    .q-out { padding-left:16px !important; padding-right:16px !important; }
    .q-in { padding-left:24px !important; padding-right:24px !important; }
    .q-code { font-size:40px !important; letter-spacing:8px !important; text-indent:8px !important; }
  }
</style>
</head><body bgcolor="${P.page}" style="margin:0;padding:0;background-color:${P.page};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(opts.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${P.page}" style="background:${P.page}">
  <tr><td align="center" bgcolor="${P.band}" style="background:${P.band}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px">
      <tr><td class="q-out" style="padding:40px 32px 36px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="vertical-align:middle">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="vertical-align:middle;padding-right:10px">${logo(30, 8, "#ffffff")}</td>
              <td style="vertical-align:middle;font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:-0.3px;color:#ffffff">Quantalog</td>
            </tr></table>
          </td>
          <td align="right" style="vertical-align:middle;font-family:${FONT};font-size:12px;font-weight:600;color:${P.bandText};white-space:nowrap">${escapeHtml(opts.label)}</td>
        </tr></table>
      </td></tr>
      <tr><td class="q-out" style="padding:0 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td class="q-in" bgcolor="${P.card}" style="background:${P.card};border-radius:24px 24px 0 0;padding:52px 52px 0">${opts.head}</td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px">
      <tr><td class="q-out" style="padding:0 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td class="q-in" bgcolor="${P.card}" style="background:${P.card};border-radius:0 0 24px 24px;padding:0 52px 48px">${opts.body}</td>
        </tr></table>
      </td></tr>
      <tr><td align="center" style="padding:32px 24px 48px">
        <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;font-weight:600">
          <a href="${LINKS.app}" style="color:${P.link};text-decoration:none">Dashboard</a>
          <span style="color:#c7c7cc">&nbsp;&nbsp;|&nbsp;&nbsp;</span>
          <a href="${LINKS.docs}" style="color:${P.link};text-decoration:none">Help Center</a>
          <span style="color:#c7c7cc">&nbsp;&nbsp;|&nbsp;&nbsp;</span>
          <a href="${LINKS.site}" style="color:${P.link};text-decoration:none">Website</a>
        </p>
        <p style="margin:12px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${P.muted}">${opts.legal}</p>
        <p style="margin:6px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${P.muted}">Copyright &copy; ${year} Quantalog. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
