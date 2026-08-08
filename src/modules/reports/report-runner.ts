import { ReportSchedule, computeNextRun, rangeForFrequency, MIN_INTERVAL_MS, type Frequency } from "./models/ReportSchedule.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { Site } from "../analytics/models/Site.js";
import { SeoReport } from "../seo/models/SeoReport.js";
import { computeStats, resolveWindow } from "../analytics/stats.service.js";
import { buildReportWorkbook, type SeoRow } from "./report-xlsx.js";
import { sendReportEmail } from "./report-mail.js";
import { sendWhatsAppReport } from "./report-whatsapp.js";
import { renderReportPage } from "./report-html.js";
import { whatsappConfigured } from "../../infra/messaging/whatsapp.js";

/**
 * Turning a due schedule into sent email.
 *
 * Shared by the nightly cron and the "send test now" button, so what an owner
 * previews is produced by the same code that will run unattended — a preview
 * that takes a different path is a preview that lies.
 *
 * The batching and the per-recipient error handling here both exist for the
 * same reason: this runs inside one Vercel function invocation with a hard
 * timeout, against Gmail SMTP with its own rate limits. A run that tries to do
 * everything at once fails at whatever point it runs out of time, having half
 * sent, with no record of where it stopped.
 */

/** How many schedules one cron invocation will attempt. The rest wait for tomorrow. */
const BATCH_LIMIT = 25;

function appUrl(): string {
  return process.env.APP_URL || "https://studio-quantalog.daorbit.in";
}

function apiUrl(): string {
  return process.env.API_URL || "https://quantalog-be.daorbit.in";
}

/** "1–7 Jan 2026" style label for the window a report covers. */
function periodLabel(frequency: Frequency, since: Date, until: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  if (frequency === "daily") return `24 hours to ${fmt(until)}`;
  return `${fmt(since)} — ${fmt(until)}`;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
}

/**
 * The latest SEO score per URL, plus the score before it for the movement
 * column.
 *
 * Two reports per URL rather than one: "score is 82" is a fact, "score is 82,
 * down 9 since last week" is the thing that makes someone open the dashboard.
 */
async function latestSeoRows(siteIds: string[]): Promise<SeoRow[]> {
  if (!siteIds.length) return [];

  const reports = await SeoReport.find({ siteId: { $in: siteIds } })
    .sort({ createdAt: -1 })
    .limit(200)
    .select("url score createdAt")
    .lean();

  const byUrl = new Map<string, SeoRow>();
  for (const r of reports) {
    const url = r.url as string;
    const existing = byUrl.get(url);
    if (!existing) {
      byUrl.set(url, { url, score: r.score as number, checkedAt: r.createdAt as Date });
    } else if (existing.previousScore === undefined) {
      // Sorted newest-first, so the second sighting of a URL is the one before.
      existing.previousScore = r.score as number;
    }
  }

  return [...byUrl.values()].sort((a, b) => a.score - b.score).slice(0, 20);
}

/**
 * The headline numbers, in the order they're read.
 *
 * Shared by both channels so an email and a WhatsApp message describing the
 * same period can't disagree — including the bounce-rate inversion, which is
 * the one that would be easy to get wrong in only one of them.
 */
function buildMetrics(stats: Awaited<ReturnType<typeof computeStats>> | null) {
  if (!stats) return [];
  return [
    { label: "Visitors", value: String(stats.visitors), delta: stats.deltas?.visitors },
    { label: "Pageviews", value: String(stats.pageviews), delta: stats.deltas?.pageviews },
    { label: "Sessions", value: String(stats.sessions), delta: stats.deltas?.sessions },
    // Negated: a bounce rate going *down* is good news, and an unnegated red
    // arrow on an improvement reads as a regression.
    {
      label: "Bounce rate",
      value: `${stats.bounceRate}%`,
      delta: stats.deltas?.bounceRate == null ? null : -stats.deltas.bounceRate,
    },
    { label: "Avg. session", value: duration(stats.avgSessionMs), delta: stats.deltas?.avgSessionMs },
    { label: "Pages / session", value: String(stats.pagesPerSession), delta: stats.deltas?.pagesPerSession },
  ];
}

/**
 * Everything a rendering of this report needs, gathered once.
 *
 * Shared by the hosted page, the email and the WhatsApp message, so all three
 * describe the same period with the same numbers. Computed on demand
 * rather than stored: the hosted link is meant to stay current, and a snapshot
 * frozen at send time would quietly go stale in the recipient's bookmark.
 */
export async function buildReportView(schedule: InstanceType<typeof ReportSchedule>) {
  const workspace = await Workspace.findById(schedule.get("workspaceId"));
  if (!workspace) throw new Error("workspace no longer exists");

  const configured = schedule.get("siteIds") as string[];
  const siteIds = configured.length
    ? configured
    : (await Site.find({ workspaceId: workspace.id }).select("siteId").lean()).map((s) => s.siteId as string);

  const frequency = schedule.get("frequency") as Frequency;
  const include = schedule.get("include") as { analytics: boolean; seo: boolean; dashboardLink: boolean };
  const range = rangeForFrequency(frequency);
  const window = resolveWindow(range);

  const stats = include.analytics && siteIds.length ? await computeStats(siteIds, range) : null;
  const seo = include.seo ? await latestSeoRows(siteIds) : [];
  const shareToken = workspace.get("shareToken") as string | undefined;

  return {
    workspace,
    workspaceName: workspace.get("name") as string,
    reportName: schedule.get("name") as string,
    frequency,
    periodLabel: periodLabel(frequency, window.since, window.until),
    stats,
    seo,
    metrics: buildMetrics(stats),
    dashboardUrl:
      include.dashboardLink && workspace.get("shareEnabled") && shareToken
        ? `${appUrl()}/share/${shareToken}`
        : undefined,
    /** The hosted view of this report — always current, safe to forward. */
    reportUrl: `${apiUrl()}/api/public/reports/view/${schedule.get("viewToken")}`,
  };
}

/** The report as a standalone HTML page, served as the hosted view. */
export async function renderScheduleHtml(schedule: InstanceType<typeof ReportSchedule>): Promise<string> {
  const view = await buildReportView(schedule);
  const s = view.stats;

  return renderReportPage({
    workspaceName: view.workspaceName,
    reportName: view.reportName,
    periodLabel: view.periodLabel,
    metrics: view.metrics,
    seo: view.seo,
    breakdowns: s
      ? [
          { title: "Top pages", label: "Page", rows: s.topPages ?? [] },
          { title: "Referrers", label: "Referrer", rows: s.topReferrers ?? [] },
          { title: "Channels", label: "Channel", rows: s.channels ?? [] },
          { title: "Countries", label: "Country", rows: s.countries ?? [] },
          { title: "Devices", label: "Device", rows: s.devices ?? [] },
        ]
      : [],
    dashboardUrl: view.dashboardUrl,
    generatedAt: new Date(),
  });
}

export type SendOutcome = {
  scheduleName: string;
  /** Email addresses the report reached. */
  sent: string[];
  failed: { email: string; error: string }[];
  skipped: string[];
  /** Phone numbers the report reached, and the ones it didn't. */
  whatsappSent: string[];
  whatsappFailed: { phone: string; error: string }[];
};

/**
 * Build and send one schedule's report to everyone still subscribed.
 *
 * Never throws for a per-recipient failure. One bad address on a list of five
 * must not cost the other four their report, so failures are collected and
 * returned rather than raised.
 */
export async function runSchedule(
  schedule: InstanceType<typeof ReportSchedule>,
  options: { isTest?: boolean; onlyTo?: string } = {}
): Promise<SendOutcome> {
  const workspace = await Workspace.findById(schedule.get("workspaceId"));
  if (!workspace) throw new Error("workspace no longer exists");

  const configured = schedule.get("siteIds") as string[];
  // An empty list means "every site in the workspace", resolved at send time so
  // a site added after the schedule was created is included automatically.
  const siteIds = configured.length
    ? configured
    : (await Site.find({ workspaceId: workspace.id }).select("siteId").lean()).map(
        (s) => s.siteId as string
      );

  const frequency = schedule.get("frequency") as Frequency;
  const include = schedule.get("include") as { analytics: boolean; seo: boolean; dashboardLink: boolean };
  const range = rangeForFrequency(frequency);
  const window = resolveWindow(range);

  const stats =
    include.analytics && siteIds.length ? await computeStats(siteIds, range) : null;
  const seo = include.seo ? await latestSeoRows(siteIds) : [];

  const label = periodLabel(frequency, window.since, window.until);

  const metrics = buildMetrics(stats);

  const xlsx = schedule.get("attachXlsx")
    ? await buildReportWorkbook({
        workspaceName: workspace.get("name") as string,
        frequency,
        periodLabel: label,
        stats,
        seo,
      })
    : undefined;

  // Only linked when sharing is actually on. A schedule created while sharing
  // was enabled must not keep mailing a link that now 404s.
  const shareToken = workspace.get("shareToken") as string | undefined;
  const dashboardUrl =
    include.dashboardLink && workspace.get("shareEnabled") && shareToken
      ? `${appUrl()}/share/${shareToken}`
      : undefined;

  const outcome: SendOutcome = {
    scheduleName: schedule.get("name") as string,
    sent: [],
    failed: [],
    skipped: [],
    whatsappSent: [],
    whatsappFailed: [],
  };

  const channels = (schedule.get("channels") ?? { email: true, whatsapp: false }) as {
    email: boolean;
    whatsapp: boolean;
  };

  if (channels.email) {
    const recipients = schedule.get("recipients") as { email: string; unsubToken: string; unsubscribedAt?: Date }[];

    for (const recipient of recipients) {
      if (options.onlyTo && recipient.email !== options.onlyTo) continue;
      if (recipient.unsubscribedAt) {
        outcome.skipped.push(recipient.email);
        continue;
      }

      try {
        await sendReportEmail({
          to: recipient.email,
          workspaceName: workspace.get("name") as string,
          periodLabel: label,
          metrics,
          seo,
          topPages: (stats?.topPages ?? []).map((r) => ({ label: r.key, value: r.count })),
          dashboardUrl,
          unsubscribeUrl: `${apiUrl()}/api/public/reports/unsubscribe/${recipient.unsubToken}`,
          xlsx,
          isTest: options.isTest,
        });
        outcome.sent.push(recipient.email);
      } catch (e) {
        outcome.failed.push({ email: recipient.email, error: (e as Error).message });
      }
    }
  }

  if (channels.whatsapp) {
    // A test send goes to the owner's email only, so it must not fan out to
    // every phone on the list — someone previewing a report should not message
    // their client to find out what it looks like.
    const phones = options.onlyTo
      ? []
      : (schedule.get("phoneRecipients") as { phone: string; optedOutAt?: Date }[]).filter(
          (p) => !p.optedOutAt
        );

    if (phones.length && !whatsappConfigured()) {
      outcome.whatsappFailed.push(...phones.map((p) => ({ phone: p.phone, error: "WhatsApp is not configured" })));
    } else {
      for (const recipient of phones) {
        try {
          await sendWhatsAppReport({
            to: recipient.phone,
            workspaceName: workspace.get("name") as string,
            periodLabel: label,
            metrics,
            seo,
            dashboardUrl,
            isTest: options.isTest,
          });
          outcome.whatsappSent.push(recipient.phone);
        } catch (e) {
          outcome.whatsappFailed.push({ phone: recipient.phone, error: (e as Error).message });
        }
      }
    }
  }

  return outcome;
}

/**
 * Send this report to one phone number, now.
 *
 * The WhatsApp counterpart to the owner-only email test: the owner picks which
 * of their own numbers to preview on, and nobody else is messaged.
 */
export async function testWhatsApp(
  schedule: InstanceType<typeof ReportSchedule>,
  phone: string
): Promise<string> {
  const workspace = await Workspace.findById(schedule.get("workspaceId"));
  if (!workspace) throw new Error("workspace no longer exists");

  const configured = schedule.get("siteIds") as string[];
  const siteIds = configured.length
    ? configured
    : (await Site.find({ workspaceId: workspace.id }).select("siteId").lean()).map((s) => s.siteId as string);

  const frequency = schedule.get("frequency") as Frequency;
  const include = schedule.get("include") as { analytics: boolean; seo: boolean; dashboardLink: boolean };
  const range = rangeForFrequency(frequency);
  const window = resolveWindow(range);

  const stats = include.analytics && siteIds.length ? await computeStats(siteIds, range) : null;
  const seo = include.seo ? await latestSeoRows(siteIds) : [];
  const shareToken = workspace.get("shareToken") as string | undefined;

  return sendWhatsAppReport({
    to: phone,
    workspaceName: workspace.get("name") as string,
    periodLabel: periodLabel(frequency, window.since, window.until),
    metrics: buildMetrics(stats),
    seo,
    dashboardUrl:
      include.dashboardLink && workspace.get("shareEnabled") && shareToken
        ? `${appUrl()}/share/${shareToken}`
        : undefined,
    isTest: true,
  });
}

export type RunSummary = {
  due: number;
  attempted: number;
  sent: number;
  failed: number;
  /** Due, but sent within the last 24h — held back by the minimum-interval guard. */
  skipped: number;
  /** WhatsApp messages delivered across the batch. */
  whatsappSent: number;
  errors: string[];
};

/**
 * Send every schedule that has come due.
 *
 * `nextRunAt` is advanced even when a run fails. Retrying tomorrow is right;
 * retrying on every cron pass until it succeeds would mean a workspace whose
 * SMTP keeps refusing generates an unbounded queue of overdue sends, all of
 * which fire at once the moment it recovers.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<RunSummary> {
  const due = await ReportSchedule.find({ enabled: true, nextRunAt: { $lte: now } })
    .sort({ nextRunAt: 1 })
    .limit(BATCH_LIMIT);

  const summary: RunSummary = { due: due.length, attempted: 0, sent: 0, failed: 0, skipped: 0, whatsappSent: 0, errors: [] };

  for (const schedule of due) {
    const lastSentAt = schedule.get("lastSentAt") as Date | undefined;
    // Independent of `nextRunAt`: a value edited directly in the database, or a
    // cron that somehow fires twice, must still not mail the same list twice in
    // one day. Recipients notice duplicates long before they notice a late report.
    if (lastSentAt && now.getTime() - lastSentAt.getTime() < MIN_INTERVAL_MS) {
      summary.skipped++;
      continue;
    }

    summary.attempted++;
    const frequency = schedule.get("frequency") as Frequency;

    try {
      const outcome = await runSchedule(schedule);
      summary.sent += outcome.sent.length;
      summary.failed += outcome.failed.length + outcome.whatsappFailed.length;
      summary.whatsappSent += outcome.whatsappSent.length;

      const problems = [
        ...outcome.failed.map((f) => `${f.email} (${f.error})`),
        ...outcome.whatsappFailed.map((f) => `${f.phone} (${f.error})`),
      ];
      if (problems.length) summary.errors.push(`${outcome.scheduleName}: ${problems.join(", ")}`);
      schedule.set("lastError", problems.length ? problems[0] : undefined);
    } catch (e) {
      summary.failed++;
      summary.errors.push(`${schedule.get("name")}: ${(e as Error).message}`);
      schedule.set("lastError", (e as Error).message);
    }

    schedule.set("lastSentAt", now);
    schedule.set("nextRunAt", computeNextRun(frequency, now));
    await schedule.save();
  }

  return summary;
}
