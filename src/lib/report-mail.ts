import { sendOne, shell, button, mailConfigured } from "./mail.js";
import type { SeoRow } from "./report-xlsx.js";

/**
 * The scheduled report email itself.
 *
 * Most recipients of this message have no account and never will — they're a
 * client, a manager, someone the owner added. Two consequences run through
 * everything below:
 *
 *  - the numbers have to be readable in the body, because a recipient who has
 *    to open a spreadsheet to learn whether traffic went up will stop opening
 *    the mail;
 *  - every message carries a working unsubscribe, in the body and in the
 *    `List-Unsubscribe` header. Mail to people who never signed up is exactly
 *    what spam filters are built to catch, and an unsubscribe link is the
 *    difference between a report and a complaint.
 */

/** `delta` is null when there was no previous period to compare against. */
type Metric = { label: string; value: string; delta?: number | null };

export type ReportEmailInput = {
  to: string;
  workspaceName: string;
  periodLabel: string;
  metrics: Metric[];
  seo: SeoRow[];
  /** Public share URL, when the owner turned the live link on. */
  dashboardUrl?: string;
  unsubscribeUrl: string;
  xlsx?: Buffer;
  /** Marks the message as a manually triggered preview rather than the real schedule. */
  isTest?: boolean;
};

function appUrl(): string {
  return process.env.APP_URL || "https://studio-quantalog.daorbit.in";
}

/** Emerald for up, red for down, grey for flat or unknown. Bounce rate is inverted by the caller, not here. */
function deltaColor(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || delta === 0) return "#6b7280";
  return delta > 0 ? "#10b981" : "#f87171";
}

function deltaText(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "";
  if (delta === 0) return "no change";
  return `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}%`;
}

/**
 * Metrics as a two-column table rather than flex or grid.
 *
 * Outlook renders neither, and a report that arrives as a single column of
 * unaligned numbers in the client half of corporate recipients use is not
 * worth the nicer markup elsewhere.
 */
function metricGrid(metrics: Metric[]): string {
  const cells = metrics
    .map(
      (m) => `
      <td width="50%" style="padding:12px 14px;vertical-align:top">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px">${m.label}</div>
        <div style="font-size:24px;font-weight:700;color:#f3f4f6;line-height:1.3">${m.value}</div>
        <div style="font-size:12px;color:${deltaColor(m.delta)}">${deltaText(m.delta)}</div>
      </td>`
    );

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    // Pad an odd final row so the last metric stays in a half-width column
    // instead of stretching across the whole table.
    const pair = cells.slice(i, i + 2);
    if (pair.length === 1) pair.push('<td width="50%"></td>');
    rows.push(`<tr>${pair.join("")}</tr>`);
  }

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
    style="background:#131519;border:1px solid #22252c;border-radius:12px;margin:0 0 20px">
    ${rows.join("")}
  </table>`;
}

function seoBlock(seo: SeoRow[]): string {
  if (!seo.length) return "";

  const rows = seo
    .slice(0, 8)
    .map((r) => {
      const moved = r.previousScore === undefined ? null : Math.round(r.score - r.previousScore);
      const movement =
        moved === null || moved === 0
          ? '<span style="color:#6b7280">—</span>'
          : `<span style="color:${moved > 0 ? "#10b981" : "#f87171"}">${moved > 0 ? "+" : ""}${moved} pts</span>`;
      return `<tr>
        <td style="padding:8px 12px;border-top:1px solid #22252c;font-size:13px;color:#9ca3af;word-break:break-all">${escapeHtml(r.url)}</td>
        <td style="padding:8px 12px;border-top:1px solid #22252c;font-size:13px;color:#f3f4f6;font-weight:600">${r.score}</td>
        <td style="padding:8px 12px;border-top:1px solid #22252c;font-size:13px">${movement}</td>
      </tr>`;
    })
    .join("");

  return `
    <p style="margin:0 0 10px;font-size:15px;font-weight:600;color:#f3f4f6">SEO</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
      style="background:#131519;border:1px solid #22252c;border-radius:12px;border-collapse:separate;margin:0 0 20px">
      <tr>
        ${["Page", "Score", "Change"]
          .map(
            (h) =>
              `<th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px">${h}</th>`
          )
          .join("")}
      </tr>
      ${rows}
    </table>`;
}

export async function sendReportEmail(input: ReportEmailInput): Promise<void> {
  if (!mailConfigured()) throw new Error("outbound email is not configured");

  const title = input.isTest
    ? `[Test] ${input.workspaceName} report`
    : `${input.workspaceName} — ${input.periodLabel}`;

  const text = [
    `${input.workspaceName} — ${input.periodLabel}`,
    ``,
    ...input.metrics.map((m) => `${m.label}: ${m.value}${m.delta !== undefined && m.delta !== null ? ` (${deltaText(m.delta)})` : ""}`),
    ...(input.seo.length ? ["", "SEO:", ...input.seo.slice(0, 8).map((r) => `${r.url} — ${r.score}`)] : []),
    ...(input.dashboardUrl ? ["", `Live dashboard: ${input.dashboardUrl}`] : []),
    ``,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = shell(
    `${
      input.isTest
        ? `<p style="margin:0 0 16px;padding:10px 12px;background:#12213a;border:1px solid #1e3a5f;border-radius:8px;font-size:13px;color:#93c5fd">
             This is a test send. Scheduled reports will look exactly like this.
           </p>`
        : ""
    }
     <p style="margin:0 0 4px;font-size:17px;font-weight:600;color:#f3f4f6">${escapeHtml(input.workspaceName)}</p>
     <p style="margin:0 0 20px;font-size:14px;color:#9ca3af">${escapeHtml(input.periodLabel)}</p>
     ${metricGrid(input.metrics)}
     ${seoBlock(input.seo)}
     ${input.xlsx ? `<p style="margin:0 0 20px;font-size:13px;color:#6b7280">The full breakdown is attached as a spreadsheet.</p>` : ""}
     ${input.dashboardUrl ? button("Open live dashboard", input.dashboardUrl) : button("Open Quantalog", appUrl())}`,
    `You're receiving this because someone shares their Quantalog reports with you. <a href="${input.unsubscribeUrl}" style="color:#6b7280">Unsubscribe</a>.`
  );

  await sendReport(input, title, text, html);
}

async function sendReport(
  input: ReportEmailInput,
  subject: string,
  text: string,
  html: string
): Promise<void> {
  await sendOne(
    { email: input.to },
    subject,
    text,
    html,
    input.xlsx
      ? [
          {
            filename: `${slug(input.workspaceName)}-report.xlsx`,
            content: input.xlsx,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        ]
      : [],
    // Gmail and Outlook surface this as a one-click unsubscribe button above
    // the message, which is where people look before reaching for "spam".
    { "List-Unsubscribe": `<${input.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "quantalog";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}
