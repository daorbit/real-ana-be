/**
 * Calls the forms service's upload-sweep route on schedule. That route does the
 * work; this Worker exists only because the sweep's grace period is measured in
 * minutes and the platform hosting the route cannot schedule itself that often.
 * See wrangler.toml for why.
 */

export interface Env {
  /** Base URL of the forms backend — a different deployment to the others here. */
  FORMS_API_BASE: string;
  CRON_SECRET: string;
}

/** Cold starts on the serverless side can time out a first attempt that would
 * have succeeded, so retry before giving up. Beyond this the next tick catches
 * up anyway: the route sweeps whatever is past its grace period rather than
 * whatever this tick missed. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callCronRoute(env: Env): Promise<void> {
  const url = `${env.FORMS_API_BASE.replace(/\/$/, "")}/api/cron/sweep-uploads`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // The route returns its error inside the JSON body, so read it either way
      // rather than reporting a bare status code.
      const body = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      // Quiet ticks are the norm — most minutes have nothing to sweep — so only
      // say something when files actually went.
      if (!body.includes('"found":0')) {
        console.log(`sweep-uploads tick ok: ${body}`);
      }
      return;
    } catch (error) {
      lastError = error as Error;
      console.warn(`sweep-uploads tick attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`);

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  // Throwing marks the invocation failed in the dashboard, which is what makes
  // a persistent outage visible instead of silently dropping every tick.
  throw new Error(`sweep-uploads tick failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.CRON_SECRET) {
      throw new Error("CRON_SECRET is not set — refusing to run");
    }

    ctx.waitUntil(callCronRoute(env));
  },
} satisfies ExportedHandler<Env>;
