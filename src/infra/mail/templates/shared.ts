import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOGO_DATA_URI } from "../../../modules/seo/logo.js";

export const LINKS = {
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

export const FONT = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

export const C = {
  page: "#f5f6f8",
  card: "#ffffff",
  panel: "#f3f4f6",
  line: "#e5e7eb",
  text: "#111827",
  dim: "#4b5563",
  faint: "#6b7280",
  accent: "#059669",
  accentDeep: "#047857",
  danger: "#dc2626",
} as const;

export type BannerName =
  | "verification-code"
  | "password-reset"
  | "password-change"
  | "invite"
  | "payment-received"
  | "plan-end"
  | "welcome"
  | "install-snippet"
  | "seo-audit"
  | "cold-invite"
  | "two-factor-backup-codes"
  | "report";

export type Theme = { accent: string; accentDeep: string; wash: string; edge: string };

export const THEMES: Record<BannerName, Theme> = {
  "verification-code": { accent: "#f97316", accentDeep: "#ea580c", wash: "#fff7f0", edge: "#ffe6d2" },
  "password-reset": { accent: "#6366f1", accentDeep: "#4f46e5", wash: "#f4f5ff", edge: "#dfe1fb" },
  "password-change": { accent: "#059669", accentDeep: "#047857", wash: "#f2fbf7", edge: "#d5efe3" },
  invite: { accent: "#2563eb", accentDeep: "#1d4ed8", wash: "#f2f7ff", edge: "#dbe8fd" },
  "payment-received": { accent: "#0d9488", accentDeep: "#0f766e", wash: "#f1fafa", edge: "#d3ecea" },
  "plan-end": { accent: "#d97706", accentDeep: "#b45309", wash: "#fffaf1", edge: "#f8e6c8" },
  welcome: { accent: "#f97316", accentDeep: "#ea580c", wash: "#fff7f0", edge: "#ffe6d2" },
  "install-snippet": { accent: "#0891b2", accentDeep: "#0e7490", wash: "#f3f8fb", edge: "#d8e9f1" },
  "seo-audit": { accent: "#16a34a", accentDeep: "#15803d", wash: "#f5fbf1", edge: "#dcefd0" },
  "cold-invite": { accent: "#f97316", accentDeep: "#ea580c", wash: "#fff7f0", edge: "#ffe6d2" },
  "two-factor-backup-codes": { accent: "#f97316", accentDeep: "#ea580c", wash: "#fff7f0", edge: "#ffe6d2" },
  report: { accent: "#059669", accentDeep: "#047857", wash: "#f2fbf7", edge: "#d5efe3" },
};

const LOGO_CID = "quantalog-logo";

export const LOGO_ATTACHMENT = {
  filename: "quantalog.png",
  content: Buffer.from(LOGO_DATA_URI.split(",")[1], "base64"),
  cid: LOGO_CID,
  contentType: "image/png",
};

export const LOGO_IMG = `<img src="cid:${LOGO_CID}" width="28" height="28" alt="Quantalog"
  style="display:block;border:0;outline:none;text-decoration:none;width:28px;height:28px">`;

export type Attachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
};

const BANNER_DIR = "email-banners";
const bannerCache = new Map<BannerName, Attachment | null>();

export function bannerCid(name: BannerName): string {
  return `quantalog-banner-${name}`;
}

export function bannerAttachment(name: BannerName): Attachment | null {
  const cached = bannerCache.get(name);
  if (cached !== undefined) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "..", "..", "public", BANNER_DIR, `${name}.jpg`),
    path.join(process.cwd(), "public", BANNER_DIR, `${name}.jpg`),
  ];

  for (const file of candidates) {
    try {
      const part: Attachment = {
        filename: `${name}.jpg`,
        content: readFileSync(file),
        cid: bannerCid(name),
        contentType: "image/jpeg",
      };
      bannerCache.set(name, part);
      return part;
    } catch {
      continue;
    }
  }

  bannerCache.set(name, null);
  return null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function bannerShell(
  banner: BannerName,
  inner: string,
  tagline: string[] = ["Secure", "Private", "Insightful"],
): string {
  const theme = THEMES[banner];
  const part = bannerAttachment(banner);

  const body = `<div bgcolor="${theme.wash}" style="background-color:${theme.wash};background-image:linear-gradient(180deg,${theme.wash} 0%,${C.card} 260px);padding:28px 16px;font-family:${FONT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto">
    <tr><td bgcolor="${C.card}" style="padding:0;background-color:${C.card}">

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
        part
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px">
        <tr><td style="font-size:0;line-height:0">
          <img src="cid:${bannerCid(banner)}" width="600" alt=""
            style="display:block;border:0;outline:none;text-decoration:none;width:100%;max-width:600px;height:auto;border-radius:10px">
        </td></tr>
      </table>`
          : ""
      }

      ${inner}

      <div style="margin-top:22px;padding-top:16px;border-top:1px solid ${C.line}">
        <p style="margin:0;font-size:12.5px;line-height:1.6">
          <a href="${LINKS.app}" style="color:${theme.accentDeep};text-decoration:none;font-weight:600">Dashboard</a>
          <span style="color:${C.line}"> &nbsp;·&nbsp; </span>
          <a href="${LINKS.docs}" style="color:${theme.accentDeep};text-decoration:none;font-weight:600">Docs</a>
          <span style="color:${C.line}"> &nbsp;·&nbsp; </span>
          <a href="${LINKS.site}" style="color:${theme.accentDeep};text-decoration:none;font-weight:600">Website</a>
        </p>
      </div>
    </td></tr>
  </table>
</div>`;

  return docShell(body);
}


/**
 * Gmail's Android/iOS app ignores `color-scheme`/`supported-color-schemes`
 * entirely and repaints dark regardless of the CSS `background`/`color` we
 * set. What it does not repaint is the legacy `bgcolor` HTML attribute, so
 * every colored table/cell in the templates below carries one alongside its
 * `style` — belt-and-braces, since other clients still need the CSS.
 */
function docShell(body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  body { background-color:${C.page} !important; }
</style>
</head><body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page}">
${body}
</body></html>`;
}

export function line(html: string, top = 10): string {
  return `<p style="margin:${top}px 0 0;font-size:14.5px;line-height:1.65;color:${C.dim}">${html}</p>`;
}

export function small(html: string, top = 10): string {
  return `<p style="margin:${top}px 0 0;font-size:12.5px;line-height:1.6;color:${C.faint}">${html}</p>`;
}

export function greetingLine(name?: string): string {
  return line(`Hello${name?.trim() ? ` ${escapeHtml(name.trim())}` : ""},`, 0);
}

export function signOff(): string {
  return line("The Quantalog Team", 10);
}

export function codeBox(code: string, banner: BannerName): string {
  const theme = THEMES[banner];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0">
    <tr><td align="center" style="background:${C.card};border:1px solid ${theme.edge};border-radius:10px;padding:16px 22px">
      <div style="font-size:28px;font-weight:700;line-height:1.2;color:${C.text};white-space:nowrap;font-family:${FONT}">${code
        .split("")
        .map((ch) => `<span style="padding:0 3px">${escapeHtml(ch)}</span>`)
        .join("")}</div>
    </td></tr>
  </table>`;
}

export function actionButton(label: string, href: string, banner: BannerName): string {
  if (!/^https?:\/\//i.test(href)) return "";
  const theme = THEMES[banner];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0"><tr>
    <td align="center" style="background:${theme.accentDeep};border-radius:8px;mso-padding-alt:11px 22px">
      <a href="${escapeAttr(href)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;line-height:1;color:#ffffff !important;text-decoration:none !important;font-family:${FONT}">${escapeHtml(label)}</a>
    </td>
  </tr></table>`;
}

export function infoPanel(title: string, detail: string, banner: BannerName): string {
  const theme = THEMES[banner];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 0">
    <tr><td style="background:${C.card};border:1px solid ${theme.edge};border-radius:10px;padding:16px 18px">
      <p style="margin:0;font-size:16px;font-weight:700;line-height:1.4;color:${C.text};letter-spacing:-0.2px">${escapeHtml(title)}</p>
      <p style="margin:5px 0 0;font-size:13px;line-height:1.6;color:${C.faint}">${escapeHtml(detail)}</p>
    </td></tr>
  </table>`;
}

export function rowsPanel(heading: string, rows: [string, string, boolean?][], banner: BannerName): string {
  const theme = THEMES[banner];
  const body = rows
    .map(
      ([k, v, strong]) => `<tr>
      <td style="padding:7px 0;font-size:13px;color:${C.faint};white-space:nowrap">${escapeHtml(k)}</td>
      <td style="padding:7px 0;font-size:${strong ? "15px" : "13px"};font-weight:${strong ? "700" : "500"};color:${strong ? theme.accentDeep : C.text};text-align:right">${escapeHtml(v)}</td>
    </tr>`,
    )
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 0">
    <tr><td style="background:${C.card};border:1px solid ${theme.edge};border-radius:10px;padding:18px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint}">${escapeHtml(heading)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${body}</table>
    </td></tr>
  </table>`;
}

export function bulletList(heading: string, items: string[], banner: BannerName): string {
  const theme = THEMES[banner];
  return `<p style="margin:18px 0 8px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint}">${escapeHtml(heading)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    ${items
      .map(
        (item) => `<tr>
      <td width="18" style="padding:0 0 10px;vertical-align:top">
        <div style="width:6px;height:6px;border-radius:50%;background:${theme.accent};margin-top:7px"></div>
      </td>
      <td style="padding:0 0 10px;vertical-align:top">
        <p style="margin:0;font-size:13.5px;line-height:1.6;color:${C.dim}">${escapeHtml(item)}</p>
      </td>
    </tr>`,
      )
      .join("")}
  </table>`;
}

export function stepList(rows: { title: string; body: string }[], banner: BannerName): string {
  const theme = THEMES[banner];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0 0">
    ${rows
      .map(
        (r, i) => `<tr>
      <td width="26" style="padding:0 0 14px;vertical-align:top">
        <div style="width:20px;height:20px;border-radius:50%;background:${theme.accent};color:#ffffff;font-size:11px;font-weight:700;line-height:20px;text-align:center">${i + 1}</div>
      </td>
      <td style="padding:0 0 14px;vertical-align:top">
        <p style="margin:0;font-size:14px;font-weight:600;color:${C.text}">${r.title}</p>
        <p style="margin:3px 0 0;font-size:13px;line-height:1.6;color:${C.dim}">${escapeHtml(r.body)}</p>
      </td>
    </tr>`,
      )
      .join("")}
  </table>`;
}

export function codeSnippet(code: string, banner: BannerName): string {
  const theme = THEMES[banner];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 0">
    <tr><td style="background:${C.panel};border:1px solid ${theme.edge};border-radius:10px;padding:16px 18px">
      <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;color:${C.text};word-break:break-all">${escapeHtml(code)}</code>
    </td></tr>
  </table>`;
}

export function warningPanel(html: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0 0">
    <tr>
      <td width="3" style="background:${C.danger};border-radius:3px 0 0 3px;font-size:0;line-height:0">&nbsp;</td>
      <td style="background:${C.panel};border-radius:0 10px 10px 0;padding:16px 18px">
        <p style="margin:0;font-size:14.5px;line-height:1.65;color:${C.dim}">${html}</p>
      </td>
    </tr>
  </table>`;
}
