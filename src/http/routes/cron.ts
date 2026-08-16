import { Router, Request, Response } from "express";
import { repriceAllPlans } from "../../modules/billing/fx.js";
import { sendFxSuccessReport, sendFxFailureReport } from "../../modules/billing/fx-report.js";
import { runDueSchedules } from "../../modules/reports/report-runner.js";
import { sweepExpiredSubmissions } from "../../modules/forms/submissions.service.js";

/**
 * Scheduled jobs invoked by Vercel Cron.
 *
 * Vercel calls these as plain GETs from its own infrastructure — there is no
 * browser, no session and no JWT, so the usual `requireAuth`/`requireAdmin`
 * chain can't apply. `CRON_SECRET` is the credential instead, exactly like the
 * signature check on the Razorpay webhook router.
 *
 * GET rather than POST because Vercel Cron only issues GETs. These handlers do
 * write, which a GET normally shouldn't — the schedule is fixed in
 * `vercel.json` and the endpoint is unguessable-by-secret, so there's no CSRF
 * surface, but it's the reason this router is separate from the admin one
 * rather than a second decorator on the same route.
 */
const router = Router();

/**
 * Rejects anything that can't prove it's the scheduler.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when the env
 * var is set. A missing `CRON_SECRET` fails closed: an unauthenticated endpoint
 * that rewrites prices is worse than a job that doesn't run.
 */
function authorizeCron(req: Request, res: Response): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set — refusing to run");
    res.status(503).json({ error: "cron is not configured" });
    return false;
  }
  if (req.get("authorization") !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * Nightly reprice of the non-INR plan prices from their INR price.
 *
 * Same code path as the admin "Sync USD prices" button — see `repriceAllPlans`.
 * A failed run leaves yesterday's prices in place, which is the right fallback:
 * a stale price is a real price, and the admin button is still there if the
 * provider outage lasts.
 */
router.get("/fx-sync", async (req: Request, res: Response) => {
  if (!authorizeCron(req, res)) return;

  try {
    const result = await repriceAllPlans();
    console.log(`[cron] repriced ${result.plans.length} plans at 1 ${result.base} = ${result.snapshot.rates.USD} USD`);
    // Awaited, not fired and forgotten: a serverless function is frozen the
    // instant the response goes out, which would kill the send mid-flight.
    await sendFxSuccessReport(result, "Vercel Cron");
    res.json({ ok: true, ...result });
  } catch (e) {
    const message = (e as Error).message;
    console.error("[cron] fx reprice failed, prices unchanged:", message);
    await sendFxFailureReport(message, "Vercel Cron");
    res.status(502).json({ ok: false, error: message });
  }
});

/**
 * Send every scheduled report that has come due.
 *
 * One cron entry covers daily, weekly and monthly alike: each schedule stores
 * its own `nextRunAt`, so frequency is arithmetic on that field rather than
 * three separate cron expressions — which also keeps this inside the Hobby
 * tier's one-run-per-day limit.
 *
 * Always 200, even when individual sends failed. A non-2xx tells Vercel the
 * job itself is broken, and a single bad recipient address is not that; the
 * failures are in the body and the logs instead.
 */
router.get("/reports", async (req: Request, res: Response) => {
  if (!authorizeCron(req, res)) return;

  try {
    const summary = await runDueSchedules();
    console.log(`[cron] reports: ${summary.attempted} due, ${summary.sent} sent, ${summary.failed} failed`);
    if (summary.errors.length) console.error("[cron] report errors:", summary.errors.join(" | "));
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[cron] report run failed:", (e as Error).message);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * Delete form submissions past the retention window their form owner set.
 *
 * Most forms have no window (`retentionDays: null`, the default) and are
 * never touched by this — see `sweepExpiredSubmissions`.
 */
router.get("/forms-retention", async (req: Request, res: Response) => {
  if (!authorizeCron(req, res)) return;

  try {
    const result = await sweepExpiredSubmissions();
    console.log(`[cron] forms retention: ${result.formsSwept} forms swept, ${result.deleted} submissions deleted`);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron] forms retention sweep failed:", (e as Error).message);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export default router;
