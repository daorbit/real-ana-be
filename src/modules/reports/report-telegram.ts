import { escapeHtml } from "../../infra/messaging/telegram.js";
import type { SeoRow } from "./report-xlsx.js";
import { shortenUrl, signed, trend } from "./report-chat-text.js";
import type { Digest } from "./digest.js";

type Metric = { label: string; value: string; delta?: number | null };

export type TelegramReportInput = {
  workspaceName: string;
  reportName: string;
  periodLabel: string;
  metrics: Metric[];
  seo: SeoRow[];
  digest?: Digest;
  dashboardUrl?: string;
  reportUrl?: string;
  isTest?: boolean;
};

export function buildTelegramReport(input: TelegramReportInput): string {
  const lines: string[] = [];

  if (input.isTest) lines.push("<i>Test send. Scheduled reports look like this.</i>", "");

  lines.push(`<b>${escapeHtml(input.reportName)}</b> · ${escapeHtml(input.workspaceName)}`, escapeHtml(input.periodLabel), "");

  for (const m of input.metrics) {
    lines.push(`${escapeHtml(m.label)}: <b>${escapeHtml(m.value)}</b>${trend(m.delta)}`);
  }

  if (input.digest) {
    lines.push("", escapeHtml(input.digest.summary));
    if (input.digest.action) lines.push(`<b>Next step:</b> ${escapeHtml(input.digest.action)}`);
  }

  if (input.seo.length) {
    lines.push("", "<b>SEO</b>");
    for (const r of input.seo.slice(0, 5)) {
      const moved = r.previousScore === undefined ? "" : ` (${signed(Math.round(r.score - r.previousScore))} pts)`;
      lines.push(`${escapeHtml(shortenUrl(r.url))} — ${r.score}${moved}`);
    }
    if (input.seo.length > 5) lines.push(`<i>+${input.seo.length - 5} more pages</i>`);
  }

  const links = [
    input.reportUrl && `<a href="${escapeHtml(input.reportUrl)}">Full report</a>`,
    input.dashboardUrl && `<a href="${escapeHtml(input.dashboardUrl)}">Live dashboard</a>`,
  ].filter(Boolean);
  if (links.length) lines.push("", links.join(" · "));

  return lines.join("\n");
}
