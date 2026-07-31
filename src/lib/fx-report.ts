import { sendOne, mailConfigured, shell, button } from "./mail.js";
import type { RepriceResult } from "./fx.js";

/**
 * The nightly "did the reprice work" email.
 *
 * Sent on both outcomes, on purpose. A mail only on failure is a mail you stop
 * trusting: silence then means either "it worked" or "the job never ran at
 * all", and those are the two cases you most need to tell apart. A nightly
 * success note that stops arriving is itself the alarm.
 *
 * Never throws. The reprice has already been committed to the database by the
 * time this runs, so a mail-server hiccup must not turn a successful job into a
 * failed request — it degrades to a log line.
 */

/** Where the nightly report goes. Overridable, since the operator isn't always the sender. */
function reportRecipient(): string {
  return process.env.FX_REPORT_EMAIL || process.env.SMTP_USER || "";
}

/** Minor units to a readable amount — 104499 becomes "1,044.99". */
function money(minor: number): string {
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function sendFxSuccessReport(result: RepriceResult, source: string): Promise<void> {
  const to = reportRecipient();
  if (!mailConfigured() || !to) return;

  const rates = result.derived
    .map((c) => `1 ${result.base} = ${result.snapshot.rates[c]} ${c}`)
    .join(", ");

  const rows = result.plans
    .map((plan) => {
      const cells = [plan.name, `${result.base} ${money(plan.priceMonthly[result.base] ?? 0)}`]
        .concat(result.derived.map((c) => `${c} ${money(plan.priceMonthly[c] ?? 0)}`));
      return `<tr>${cells
        .map(
          (cell, i) =>
            `<td style="padding:8px 12px;border-top:1px solid #22252c;color:${i === 0 ? "#f3f4f6" : "#9ca3af"};font-size:14px">${cell}</td>`
        )
        .join("")}</tr>`;
    })
    .join("");

  const header = ["Plan", `${result.base} / month`]
    .concat(result.derived.map((c) => `${c} / month`))
    .map((h) => `<th style="padding:8px 12px;text-align:left;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.4px">${h}</th>`)
    .join("");

  const text = [
    `Plan prices repriced successfully (${source}).`,
    ``,
    `Rate: ${rates}`,
    `Plans updated: ${result.plans.length}`,
    ``,
    ...result.plans.map(
      (p) =>
        `${p.name}: ${result.base} ${money(p.priceMonthly[result.base] ?? 0)}/mo` +
        result.derived.map((c) => ` -> ${c} ${money(p.priceMonthly[c] ?? 0)}`).join("")
    ),
  ].join("\n");

  const html = shell(
    `<p style="margin:0 0 8px;font-size:17px;font-weight:600;color:#f3f4f6">Plan prices repriced</p>
     <p style="margin:0 0 20px;font-size:14px;color:#9ca3af">
       ${result.plans.length} plan${result.plans.length === 1 ? "" : "s"} updated from the ${result.base} price at today's rate.
       <br><span style="color:#10b981;font-weight:600">${rates}</span>
     </p>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
       <tr>${header}</tr>
       ${rows}
     </table>
     <p style="margin:20px 0 0;font-size:12px;color:#6b7280">Triggered by ${source}.</p>`,
    "You're receiving this because you're listed as the billing operator for Quantalog."
  );

  await deliver(to, `Plan prices repriced — ${rates}`, text, html);
}

export async function sendFxFailureReport(error: string, source: string): Promise<void> {
  const to = reportRecipient();
  if (!mailConfigured() || !to) return;

  const text = [
    `Plan repricing FAILED (${source}).`,
    ``,
    `Error: ${error}`,
    ``,
    `Prices are unchanged — the previous rate is still in effect. No customer sees a wrong price.`,
    `Retry from Admin - Plans & addons - "Sync USD prices", or wait for tomorrow's run.`,
  ].join("\n");

  const html = shell(
    `<p style="margin:0 0 8px;font-size:17px;font-weight:600;color:#f3f4f6">Plan repricing failed</p>
     <p style="margin:0 0 16px;font-size:14px;color:#9ca3af">
       The exchange rate could not be fetched, so no plan was changed.
       Prices are still yesterday's — nothing is broken for customers.
     </p>
     <p style="margin:0 0 20px;padding:12px 14px;background:#1a1214;border:1px solid #3f2226;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#fca5a5">${escapeHtml(error)}</p>
     ${button("Open admin billing", `${process.env.APP_URL || "https://studio-quantalog.daorbit.in"}/admin/billing`)}
     <p style="margin:20px 0 0;font-size:12px;color:#6b7280">Triggered by ${source}.</p>`,
    "You're receiving this because you're listed as the billing operator for Quantalog."
  );

  await deliver(to, "Plan repricing failed — prices unchanged", text, html);
}

/**
 * Send, and swallow anything that goes wrong.
 *
 * The reprice itself has already succeeded or failed by now and been reported
 * to the caller; this mail is a notification about that outcome, so it must
 * never become the thing that changes it.
 */
async function deliver(to: string, subject: string, text: string, html: string): Promise<void> {
  try {
    await sendOne({ email: to }, subject, text, html);
  } catch (e) {
    console.error("[fx-report] could not send report email:", (e as Error).message);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}
