import { sendOne, shell, button, mailConfigured, statTile, barRow, C } from "../../infra/mail/mailer.js";
import type { SeoRow } from "./report-xlsx.js";
import type { Digest } from "./digest.js";

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
  /** Busiest pages, for the bar breakdown. Absent when analytics is off. */
  topPages?: { label: string; value: number }[];
  /** The plain-language read of the period. Absent when it could not be written. */
  digest?: Digest;
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
  if (delta === null || delta === undefined || delta === 0) return C.faint;
  return delta > 0 ? C.accent : C.danger;
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
  const cells = metrics.map((m) =>
    statTile(
      escapeHtml(m.label),
      escapeHtml(m.value),
      deltaText(m.delta) || undefined,
      m.delta === null || m.delta === undefined || m.delta === 0 ? "flat" : m.delta > 0 ? "up" : "down"
    )
  );

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    // Pad an odd final row so the last metric stays in a half-width column
    // instead of stretching across the whole table.
    const pair = cells.slice(i, i + 2);
    if (pair.length === 1) pair.push('<td width="50%"></td>');
    // A spacer column between the two tiles: `border-spacing` is unreliable in
    // Outlook, and margins on a `td` do nothing at all.
    rows.push(`<tr>${pair[0]}<td width="12" style="font-size:0;line-height:0">&nbsp;</td>${pair[1]}</tr>`);
    rows.push(`<tr><td colspan="3" height="12" style="font-size:0;line-height:0">&nbsp;</td></tr>`);
  }

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px">
    ${rows.join("")}
  </table>`;
}

/**
 * A breakdown as bar rows — the stand-in for a chart.
 *
 * Bars are drawn as table cells with a percentage width, so they need no image
 * and appear the moment the message opens. An image would be hidden behind the
 * client's "show images" prompt, which for an email whose entire content is
 * numbers is the wrong thing to hide.
 *
 * Shares are normalised against the largest row rather than the total: the
 * point is comparing rows with each other, and against a total the top row of
 * a long tail would be a sliver.
 */
function breakdown(title: string, rows: { label: string; value: number }[], format: (n: number) => string): string {
  if (!rows.length) return "";
  const top = rows.slice(0, 5);
  const max = Math.max(...top.map((r) => r.value), 1);

  return `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${C.text}">${escapeHtml(title)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="panel"
      style="background:${C.panel};border-radius:10px;margin:0 0 20px">
      ${top.map((r) => barRow(escapeHtml(r.label), format(r.value), (r.value / max) * 100)).join("")}
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
          ? `<span style="color:${C.faint}">—</span>`
          : `<span style="color:${moved > 0 ? C.accent : C.danger}">${moved > 0 ? "+" : ""}${moved} pts</span>`;
      return `<tr>
        <td style="padding:9px 12px;border-top:1px solid ${C.line};font-size:13px;color:${C.dim};word-break:break-all">${escapeHtml(r.url)}</td>
        <td style="padding:9px 12px;border-top:1px solid ${C.line};font-size:13px;color:${C.text};font-weight:700">${r.score}</td>
        <td style="padding:9px 12px;border-top:1px solid ${C.line};font-size:13px;font-weight:600">${movement}</td>
      </tr>`;
    })
    .join("");

  return `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:${C.text}">SEO scores</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="panel"
      style="background:${C.panel};border-radius:10px;border-collapse:separate;margin:0 0 20px">
      <tr>
        ${["Page", "Score", "Change"]
          .map(
            (h) =>
              `<th style="padding:9px 12px;text-align:left;font-size:11px;color:${C.faint};text-transform:uppercase;letter-spacing:0.6px;font-weight:600">${h}</th>`
          )
          .join("")}
      </tr>
      ${rows}
    </table>`;
}

/**
 * The plain-language read of the period, above the numbers.
 *
 * Placed first because it is the only part most recipients will read, and set
 * on a tinted panel so it is visibly commentary rather than another figure —
 * the reader should never have to wonder whether a sentence is measured or
 * interpreted. The recommendation is given its own line for the same reason it
 * was parsed out separately: it is the part someone might act on.
 *
 * Returns nothing at all when there is no digest, so a report that could not
 * get one looks exactly like a report from before this existed — no empty
 * panel, no apology, no gap.
 */
function digestBlock(digest: Digest | undefined): string {
  if (!digest) return "";

  const action = digest.action
    ? `<p style="margin:10px 0 0;font-size:13.5px;line-height:1.6;color:${C.text}">
         <strong style="color:${C.accentDeep}">Worth doing:</strong> ${escapeHtml(digest.action)}
       </p>`
    : "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      <tr>
        <td style="padding:14px 16px;background:${C.panel};border-left:3px solid ${C.accent};border-radius:6px">
          <!-- Labelled, not silent. This paragraph makes causal claims — "traffic
               rose because of X" — and it is occasionally wrong. A reader who
               knows it was written by a model can weigh it accordingly; one who
               assumes it was measured cannot, and may forward a wrong claim to
               their own client as fact. -->
          <p style="margin:0 0 7px;font-size:10.5px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;color:${C.faint}">
            AI summary
          </p>
          <p style="margin:0;font-size:13.5px;line-height:1.65;color:${C.dim}">${escapeHtml(digest.summary)}</p>
          ${action}
        </td>
      </tr>
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
    ...(input.digest
      ? [
          input.digest.summary,
          ...(input.digest.action ? [``, `Worth doing: ${input.digest.action}`] : []),
          ``,
        ]
      : []),
    ...input.metrics.map((m) => `${m.label}: ${m.value}${m.delta !== undefined && m.delta !== null ? ` (${deltaText(m.delta)})` : ""}`),
    ...(input.seo.length ? ["", "SEO:", ...input.seo.slice(0, 8).map((r) => `${r.url} — ${r.score}`)] : []),
    ...(input.dashboardUrl ? ["", `Live dashboard: ${input.dashboardUrl}`] : []),
    ``,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = shell(
    `${
      input.isTest
        ? `<p style="margin:0 0 20px;padding:11px 14px;background:#eff6ff;border-radius:8px;font-size:13px;line-height:1.6;color:#1d4ed8">
             This is a test send. Scheduled reports will look exactly like this.
           </p>`
        : ""
    }
     <p style="margin:0 0 3px;font-size:18px;font-weight:700;color:${C.text};letter-spacing:-0.3px">${escapeHtml(input.workspaceName)}</p>
     <p style="margin:0 0 22px;font-size:13px;color:${C.faint}">${escapeHtml(input.periodLabel)}</p>
     ${digestBlock(input.digest)}
     ${metricGrid(input.metrics)}
     ${breakdown("Top pages", input.topPages ?? [], (n) => n.toLocaleString("en-US"))}
     ${seoBlock(input.seo)}
     ${input.xlsx ? `<p style="margin:0 0 20px;font-size:12.5px;color:${C.faint}">The full breakdown is attached as a spreadsheet.</p>` : ""}
     ${input.dashboardUrl ? button("Open live dashboard", input.dashboardUrl) : button("Open Quantalog", appUrl())}`,
    // This is the one message that must keep a line under the card: most
    // recipients never signed up for anything, and the unsubscribe link is what
    // separates a report from a spam complaint.
    `Someone shares their Quantalog reports with you. <a href="${input.unsubscribeUrl}" style="color:${C.faint}">Unsubscribe</a>.`
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
