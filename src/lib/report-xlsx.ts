import ExcelJS from "exceljs";
import type { Frequency } from "../plans.js";

/**
 * The spreadsheet attached to a scheduled report.
 *
 * Written to a Buffer rather than streamed to a response, unlike the on-demand
 * export in `routes/workspaces.ts`: there is no `res` here, the consumer is
 * nodemailer, and the whole file has to exist before the message can be sent.
 *
 * This is a summary, not a dump. The on-demand export gives one row per event
 * for people doing their own analysis; a monthly report opened on someone's
 * phone needs the same numbers the email shows, with enough breakdown to answer
 * the obvious follow-up question. Raw events would be a 50MB attachment nobody
 * opens.
 */

/** What `computeStats` returns, narrowed to the parts the workbook uses. */
type StatsLike = {
  visitors: number;
  pageviews: number;
  sessions: number;
  bounceRate: number;
  avgSessionMs: number;
  pagesPerSession: number;
  /** Null where there was no previous period to compare against — a new site's first report. */
  deltas?: Record<string, number | null>;
  topPages?: Row[];
  topReferrers?: Row[];
  countries?: Row[];
  devices?: Row[];
  browsers?: Row[];
  channels?: Row[];
  /** `key` is the event name — matching what `computeStats` returns for every breakdown. */
  customEvents?: { key: string; visitors: number; count: number; conversionRate: number }[];
};

type Row = { key: string; count: number };

export type SeoRow = {
  url: string;
  score: number;
  /** Score at the previous report, when there was one — drives the movement column. */
  previousScore?: number;
  checkedAt: Date;
};

export type ReportWorkbookInput = {
  workspaceName: string;
  frequency: Frequency;
  periodLabel: string;
  stats: StatsLike | null;
  seo: SeoRow[];
};

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF10B981" },
};

/** Milliseconds as "2m 14s" — a raw 134000 in a cell helps nobody. */
function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
}

/** A delta as a signed percentage, or an em dash when there's no prior period to compare against. */
function change(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value}%`;
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = HEADER_FILL;
  row.height = 20;
}

/** A titled table on its own sheet. Skipped entirely when there's no data — an empty sheet reads as a bug. */
function addBreakdown(wb: ExcelJS.Workbook, title: string, label: string, rows: Row[] | undefined): void {
  if (!rows?.length) return;
  const sheet = wb.addWorksheet(title);
  sheet.columns = [
    { header: label, key: "key", width: 52 },
    { header: "Count", key: "count", width: 14 },
  ];
  rows.forEach((r) => sheet.addRow({ key: r.key, count: r.count }));
  styleHeader(sheet);
}

export async function buildReportWorkbook(input: ReportWorkbookInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Quantalog";
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Value", key: "value", width: 18 },
    { header: "Change", key: "change", width: 14 },
  ];

  const { stats } = input;
  if (stats) {
    const d = stats.deltas ?? {};
    summary.addRows([
      { metric: "Visitors", value: stats.visitors, change: change(d.visitors) },
      { metric: "Pageviews", value: stats.pageviews, change: change(d.pageviews) },
      { metric: "Sessions", value: stats.sessions, change: change(d.sessions) },
      { metric: "Bounce rate", value: `${stats.bounceRate}%`, change: change(d.bounceRate) },
      { metric: "Avg. session", value: duration(stats.avgSessionMs), change: change(d.avgSessionMs) },
      { metric: "Pages / session", value: stats.pagesPerSession, change: change(d.pagesPerSession) },
    ]);
  } else {
    summary.addRow({ metric: "Analytics", value: "not included in this report", change: "" });
  }

  // Context rows sit under the numbers rather than above them, so the figures
  // are the first thing visible when the file opens.
  summary.addRow({});
  summary.addRow({ metric: "Workspace", value: input.workspaceName });
  summary.addRow({ metric: "Period", value: input.periodLabel });
  summary.addRow({ metric: "Generated", value: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" });
  styleHeader(summary);

  if (stats) {
    addBreakdown(wb, "Top pages", "Page", stats.topPages);
    addBreakdown(wb, "Referrers", "Referrer", stats.topReferrers);
    addBreakdown(wb, "Channels", "Channel", stats.channels);
    addBreakdown(wb, "Countries", "Country", stats.countries);
    addBreakdown(wb, "Devices", "Device", stats.devices);
    addBreakdown(wb, "Browsers", "Browser", stats.browsers);

    if (stats.customEvents?.length) {
      const sheet = wb.addWorksheet("Goals & events");
      sheet.columns = [
        { header: "Event", key: "key", width: 34 },
        { header: "Visitors", key: "visitors", width: 14 },
        { header: "Total fired", key: "count", width: 14 },
        { header: "Conversion", key: "conversionRate", width: 14 },
      ];
      stats.customEvents.forEach((e) =>
        sheet.addRow({ ...e, conversionRate: `${e.conversionRate}%` })
      );
      styleHeader(sheet);
    }
  }

  if (input.seo.length) {
    const sheet = wb.addWorksheet("SEO");
    sheet.columns = [
      { header: "URL", key: "url", width: 58 },
      { header: "Score", key: "score", width: 10 },
      { header: "Change", key: "movement", width: 12 },
      { header: "Checked", key: "checkedAt", width: 20 },
    ];
    input.seo.forEach((r) => {
      const movement =
        r.previousScore === undefined ? "—" : change(Math.round(r.score - r.previousScore));
      sheet.addRow({
        url: r.url,
        score: r.score,
        // Score movement is already in points, so it's shown as a point
        // difference rather than run through the percentage formatter.
        movement: movement === "—" ? "—" : movement.replace("%", " pts"),
        checkedAt: r.checkedAt.toISOString().slice(0, 16).replace("T", " "),
      });
    });
    styleHeader(sheet);
  }

  // exceljs declares its own `Buffer` alias that doesn't structurally match
  // Node's, so the cast has to go through `unknown`. The runtime value is a
  // real Node Buffer — this is a types-only mismatch.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}
