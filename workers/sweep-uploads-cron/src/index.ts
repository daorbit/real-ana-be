export interface Env {
  FORMS_API_BASE: string;
  CRON_SECRET: string;
}

interface Task {
  path: string;
  quietWhen: string;
}

const EVERY_TICK: Task[] = [
  { path: "sweep-uploads", quietWhen: '"found":0' },
  { path: "sweep-payments", quietWhen: '"deleted":0,"staleBookingHolds":0' },
];

const DAILY: Task = { path: "sweep-partials", quietWhen: '"deletedCount":0' };
const DAILY_HOUR_UTC = 3;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callCronRoute(env: Env, task: Task): Promise<void> {
  const url = `${env.FORMS_API_BASE.replace(/\/$/, "")}/api/cron/${task.path}`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const body = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      if (!body.includes(task.quietWhen)) {
        console.log(`${task.path} tick ok: ${body}`);
      }
      return;
    } catch (error) {
      lastError = error as Error;
      console.warn(`${task.path} tick attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`);

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`${task.path} tick failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

function tasksFor(scheduledTime: number): Task[] {
  const at = new Date(scheduledTime);
  const daily = at.getUTCHours() === DAILY_HOUR_UTC && at.getUTCMinutes() === 0;
  return daily ? [...EVERY_TICK, DAILY] : EVERY_TICK;
}

async function runAll(env: Env, tasks: Task[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => callCronRoute(env, task)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) {
    throw new Error(failed.map((r) => (r.reason as Error).message).join(" | "));
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.CRON_SECRET) {
      throw new Error("CRON_SECRET is not set — refusing to run");
    }

    ctx.waitUntil(runAll(env, tasksFor(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
