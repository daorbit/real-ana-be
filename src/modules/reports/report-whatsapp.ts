import { sendWhatsApp } from "../../infra/messaging/whatsapp.js";
import type { SeoRow } from "./report-xlsx.js";

/**
 * The scheduled report, as a WhatsApp message.
 *
 * A different medium, not the email with the tags stripped. Someone reading
 * this is on a phone, in a chat thread, between other messages — so it opens
 * with the numbers rather than a greeting, runs to a dozen lines rather than a
 * screen, and stops. Anyone who wants the breakdown has the dashboard link at
 * the bottom and the spreadsheet in their email.
 *
 * WhatsApp's markup is its own: `*bold*`, `_italic_`, no links markup (URLs
 * autolink), and no tables. Anything fancier arrives as literal asterisks.
 */

type Metric = { label: string; value: string; delta?: number | null };

export type WhatsAppReportInput = {
  to: string;
  workspaceName: string;
  periodLabel: string;
  metrics: Metric[];
  seo: SeoRow[];
  dashboardUrl?: string;
  isTest?: boolean;
};

/** An arrow and a signed percentage, or nothing when there's no prior period. */
function trend(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "";
  if (delta === 0) return " (no change)";
  return ` (${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}%)`;
}

/**
 * Build the message body.
 *
 * Exported so a test can assert the formatting without sending anything through
 * a real WhatsApp account.
 */
export function buildWhatsAppReport(input: WhatsAppReportInput): string {
  const lines: string[] = [];

  if (input.isTest) lines.push("_Test send — scheduled reports look like this._", "");

  lines.push(`*${input.workspaceName}*`, input.periodLabel, "");

  for (const m of input.metrics) {
    lines.push(`${m.label}: *${m.value}*${trend(m.delta)}`);
  }

  if (input.seo.length) {
    lines.push("", "*SEO*");
    // Three, not the email's eight: past that, a phone shows a wall of URLs and
    // the reader scrolls past the whole message.
    for (const r of input.seo.slice(0, 3)) {
      const moved =
        r.previousScore === undefined ? "" : ` (${signed(Math.round(r.score - r.previousScore))} pts)`;
      lines.push(`${shortenUrl(r.url)} — ${r.score}${moved}`);
    }
    if (input.seo.length > 3) lines.push(`_+${input.seo.length - 3} more pages_`);
  }

  if (input.dashboardUrl) lines.push("", `Live dashboard: ${input.dashboardUrl}`);

  return lines.join("\n");
}

export async function sendWhatsAppReport(input: WhatsAppReportInput): Promise<string> {
  return sendWhatsApp(input.to, buildWhatsAppReport(input));
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * A URL short enough to read in a chat bubble.
 *
 * The host is dropped — every page in a report belongs to the same site, so
 * repeating the domain on every line costs width and says nothing.
 */
function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/$/, "");
    return path.length > 40 ? `${path.slice(0, 37)}…` : path;
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}…` : url;
  }
}
