/**
 * Calls the fx-sync cron route on schedule. That route does the reprice; this
 * Worker exists only to trigger it punctually at a fixed local time — see
 * wrangler.toml for why that matters here and not on Vercel's own cron.
 */

export interface Env {
  API_BASE: string;
  CRON_SECRET: string;
}

/** Cold starts on the Vercel side can time out a first attempt that would have
 * succeeded, so retry before giving up. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callCronRoute(env: Env): Promise<void> {
  const url = `${env.API_BASE.replace(/\/$/, "")}/api/cron/fx-sync`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // The route returns its error inside the JSON body, so read it either way
      // rather than reporting a bare status code.
      const body = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      console.log(`fx-sync tick ok: ${body}`);
      return;
    } catch (error) {
      lastError = error as Error;
      console.warn(`fx-sync tick attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`);

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  // Throwing marks the invocation failed in the dashboard, which is what makes
  // a persistent outage visible instead of silently dropping the run.
  throw new Error(`fx-sync tick failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.CRON_SECRET) {
      throw new Error("CRON_SECRET is not set — refusing to run");
    }

    ctx.waitUntil(callCronRoute(env));
  },
} satisfies ExportedHandler<Env>;
