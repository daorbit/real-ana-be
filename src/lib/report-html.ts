import type { SeoRow } from "./report-xlsx.js";

/**
 * The report as a standalone HTML page.
 *
 * Served as the hosted view a recipient opens from a link in their report.
 *
 * Self-contained by necessity rather than preference: the page is opened from
 * a link by someone with no session here, so any stylesheet, font or image that
 * lives elsewhere either fails to load or silently changes the output. Every
 * style is inline, and the only images are ones drawn with CSS.
 *
 * Print rules live in the same document, so a recipient who wants a file hits
 * Ctrl+P and gets the same layout the page shows.
 */

type Metric = { label: string; value: string; delta?: number | null };

export type ReportPageInput = {
  workspaceName: string;
  reportName: string;
  periodLabel: string;
  metrics: Metric[];
  seo: SeoRow[];
  /** Breakdown tables, in display order. Empty ones are dropped by the caller. */
  breakdowns: { title: string; label: string; rows: { key: string; count: number }[] }[];
  dashboardUrl?: string;
  generatedAt: Date;
};

const INK = "#0f1115";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const ACCENT = "#059669";

/**
 * Light, not the app's dark theme.
 *
 * This document is printed and forwarded. A dark background is a page of
 * toner, and a client who prints one gets something unreadable — so the hosted
 * view matches the artefact it produces.
 */
export function renderReportPage(input: ReportPageInput): string {
  const { metrics, seo, breakdowns } = input;

  // Three per row, padded so a trailing partial row keeps its column widths.
  const metricRows: string[] = [];
  const cells = metrics.map(
    (m) => `
      <td class="metric">
        <div class="metric-label">${escapeHtml(m.label)}</div>
        <div class="metric-value">${escapeHtml(m.value)}</div>
        <div class="metric-delta ${deltaClass(m.delta)}">${deltaText(m.delta)}</div>
      </td>`
  );
  for (let i = 0; i < cells.length; i += 3) {
    const row = cells.slice(i, i + 3);
    while (row.length < 3) row.push('<td class="metric"></td>');
    metricRows.push(`<tr>${row.join("")}</tr>`);
  }

  const seoSection = seo.length
    ? `
    <section>
      <h2>SEO</h2>
      <table class="data">
        <thead><tr><th>Page</th><th class="num">Score</th><th class="num">Change</th></tr></thead>
        <tbody>
          ${seo
            .slice(0, 15)
            .map((r) => {
              const moved = r.previousScore === undefined ? null : Math.round(r.score - r.previousScore);
              const movement =
                moved === null || moved === 0
                  ? '<span class="flat">—</span>'
                  : `<span class="${moved > 0 ? "up" : "down"}">${moved > 0 ? "+" : ""}${moved} pts</span>`;
              return `<tr>
                <td class="url">${escapeHtml(r.url)}</td>
                <td class="num"><strong>${r.score}</strong></td>
                <td class="num">${movement}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </section>`
    : "";

  const breakdownSections = breakdowns
    .filter((b) => b.rows.length)
    .map(
      (b) => `
    <section class="break-inside-avoid">
      <h2>${escapeHtml(b.title)}</h2>
      <table class="data">
        <thead><tr><th>${escapeHtml(b.label)}</th><th class="num">Count</th></tr></thead>
        <tbody>
          ${b.rows
            .slice(0, 10)
            .map((r) => `<tr><td class="url">${escapeHtml(r.key)}</td><td class="num">${r.count}</td></tr>`)
            .join("")}
        </tbody>
      </table>
    </section>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.reportName)} — ${escapeHtml(input.workspaceName)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f6f7f9;color:${INK};
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    font-size:14px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{max-width:820px;margin:32px auto;background:#fff;border:1px solid ${LINE};
    border-radius:14px;padding:40px 44px}
  header{border-bottom:2px solid ${INK};padding-bottom:18px;margin-bottom:28px}
  .brand{font-size:15px;font-weight:700;letter-spacing:-0.2px}
  .brand span{color:${ACCENT}}
  h1{font-size:26px;margin:14px 0 4px;letter-spacing:-0.5px}
  .period{color:${MUTED};font-size:13px;margin:0}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};
    margin:32px 0 10px;font-weight:700}
  table{width:100%;border-collapse:collapse}
  .metrics td{width:33.33%;padding:14px 16px;border:1px solid ${LINE};vertical-align:top}
  .metric-label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${MUTED}}
  .metric-value{font-size:26px;font-weight:700;letter-spacing:-0.6px;margin-top:3px}
  .metric-delta{font-size:12px;margin-top:2px}
  .up{color:${ACCENT}} .down{color:#dc2626} .flat{color:${MUTED}}
  .data th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;
    color:${MUTED};padding:8px 10px;border-bottom:1px solid ${LINE}}
  .data td{padding:8px 10px;border-bottom:1px solid #f1f2f4;font-size:13px}
  .data .num{text-align:right;white-space:nowrap}
  .url{word-break:break-word;max-width:460px}
  .cta{display:inline-block;margin-top:26px;background:${ACCENT};color:#fff;
    text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:13px}
  footer{margin-top:34px;padding-top:16px;border-top:1px solid ${LINE};
    color:${MUTED};font-size:11px}
  /* Printing turns the card back into a plain page — the border and the
     background would otherwise render as a box drawn around every sheet. */
  @media print{
    body{background:#fff}
    .sheet{margin:0;border:none;border-radius:0;padding:0;max-width:none}
    .cta{display:none}
    .break-inside-avoid{break-inside:avoid}
    @page{margin:16mm}
  }
</style>
</head><body>
<div class="sheet">
  <header>
    <div class="brand">Quantalog<span>.</span></div>
    <h1>${escapeHtml(input.workspaceName)}</h1>
    <p class="period">${escapeHtml(input.reportName)} · ${escapeHtml(input.periodLabel)}</p>
  </header>

  ${
    metricRows.length
      ? `<table class="metrics">${metricRows.join("")}</table>`
      : '<p class="period">No analytics were included in this report.</p>'
  }

  ${seoSection}
  ${breakdownSections}

  ${
    input.dashboardUrl
      ? `<a class="cta" href="${escapeAttr(input.dashboardUrl)}">Open the live dashboard</a>`
      : ""
  }

  <footer>
    Generated ${input.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC ·
    This page always shows the latest figures for the period above.
  </footer>
</div>
</body></html>`;
}

function deltaClass(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || delta === 0) return "flat";
  return delta > 0 ? "up" : "down";
}

function deltaText(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "—";
  if (delta === 0) return "no change";
  return `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs. previous`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
