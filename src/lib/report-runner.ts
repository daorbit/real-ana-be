import { ReportSchedule, computeNextRun, rangeForFrequency, MIN_INTERVAL_MS, type Frequency } from "../models/ReportSchedule.js";
import { Workspace } from "../models/Workspace.js";
import { Site } from "../models/Site.js";
import { SeoReport } from "../models/SeoReport.js";
import { computeStats, resolveWindow } from "../stats-core.js";
import { buildReportWorkbook, type SeoRow } from "./report-xlsx.js";
import { sendReportEmail } from "./report-mail.js";

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

export type SendOutcome = {
  scheduleName: string;
  sent: string[];
  failed: { email: string; error: string }[];
  skipped: string[];
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

  const metrics = stats
    ? [
        { label: "Visitors", value: String(stats.visitors), delta: stats.deltas?.visitors },
        { label: "Pageviews", value: String(stats.pageviews), delta: stats.deltas?.pageviews },
        { label: "Sessions", value: String(stats.sessions), delta: stats.deltas?.sessions },
        // Bounce delta is negated: a bounce rate going *down* is good news, and
        // an unnegated red arrow on an improvement reads as a regression.
        {
          label: "Bounce rate",
          value: `${stats.bounceRate}%`,
          delta: stats.deltas?.bounceRate == null ? null : -stats.deltas.bounceRate,
        },
        { label: "Avg. session", value: duration(stats.avgSessionMs), delta: stats.deltas?.avgSessionMs },
        { label: "Pages / session", value: String(stats.pagesPerSession), delta: stats.deltas?.pagesPerSession },
      ]
    : [];

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

  const outcome: SendOutcome = { scheduleName: schedule.get("name") as string, sent: [], failed: [], skipped: [] };
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

  return outcome;
}

export type RunSummary = {
  due: number;
  attempted: number;
  sent: number;
  failed: number;
  /** Due, but sent within the last 24h — held back by the minimum-interval guard. */
  skipped: number;
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

  const summary: RunSummary = { due: due.length, attempted: 0, sent: 0, failed: 0, skipped: 0, errors: [] };

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
      summary.failed += outcome.failed.length;
      if (outcome.failed.length) {
        summary.errors.push(`${outcome.scheduleName}: ${outcome.failed.map((f) => `${f.email} (${f.error})`).join(", ")}`);
      }
      schedule.set("lastError", outcome.failed.length ? outcome.failed[0].error : undefined);
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
