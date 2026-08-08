import cron from "node-cron";
import { repriceAllPlans, fxConfigured } from "./fx.js";
import { sendFxSuccessReport, sendFxFailureReport } from "./fx-report.js";

/**
 * In-process nightly repricing, for hosts where the process stays alive.
 *
 * OFF by default, and deliberately so. Production runs on Vercel, where the
 * schedule is `vercel.json`'s `crons` entry hitting `/api/cron/fx-sync` — a
 * serverless process doesn't survive between requests, so an in-process timer
 * there would simply never fire.
 *
 * This exists for the other case: `npm run dev`, or a move to a long-running
 * host (Render/Railway/VPS), where Vercel Cron isn't calling anything. Set
 * `FX_CRON_ENABLED=true` there.
 *
 * Keeping it opt-in means the two schedulers can never both be live against the
 * same database, repricing twice from the same rate.
 *
 * Scheduled rather than continuous because the upstream free tier refreshes its
 * rates once every 24h — polling more often costs API calls and returns the
 * same number.
 */

/** 02:30 daily. Off-peak, and comfortably after the provider's 00:00 UTC refresh. */
const DEFAULT_SCHEDULE = "30 2 * * *";

export function startFxCron(): void {
  if (process.env.FX_CRON_ENABLED !== "true") {
    // Silent: on Vercel this is the normal, expected state, and a line every
    // cold start about a scheduler that was never meant to run is just noise.
    return;
  }

  if (!fxConfigured()) {
    // Without a key every run would fail identically. Say so once at boot
    // rather than logging the same error every night.
    console.log("[fx-cron] EXCHANGERATE_API_KEY not set — skipping schedule");
    return;
  }

  const schedule = process.env.FX_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`[fx-cron] invalid FX_CRON_SCHEDULE "${schedule}" — skipping schedule`);
    return;
  }

  cron.schedule(schedule, runFxSync, { timezone: process.env.FX_CRON_TZ || "UTC" });
  console.log(`[fx-cron] scheduled "${schedule}" (${process.env.FX_CRON_TZ || "UTC"})`);
}

/**
 * One repricing run.
 *
 * Swallows its own errors: an unhandled rejection inside a cron tick takes the
 * whole server down, and a rate provider having a bad night is not a reason to
 * stop serving analytics. A failed run leaves yesterday's prices in place,
 * which is the correct fallback — the admin button is still there if the
 * outage lasts.
 */
async function runFxSync(): Promise<void> {
  try {
    const result = await repriceAllPlans();
    const rate = result.snapshot.rates.USD;
    console.log(`[fx-cron] repriced ${result.plans.length} plans at 1 ${result.base} = ${rate} USD`);
    await sendFxSuccessReport(result, "in-process cron");
  } catch (e) {
    const message = (e as Error).message;
    console.error("[fx-cron] reprice failed, prices unchanged:", message);
    await sendFxFailureReport(message, "in-process cron");
  }
}
