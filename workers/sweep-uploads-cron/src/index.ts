import { failingServices, QUANTALOG_API, type HealthEnv } from "./health";
import { sendOpsAlert, type AlertEnv, type OpsAlert } from "./telegram";
import { diffDownState, type DownChange, type StateEnv } from "./downState";

export type Env = HealthEnv & AlertEnv & StateEnv & { INVOICES_API_BASE?: string };

type Service = "forms" | "invoices";

interface Task {
  service: Service;
  path: string;
  quietWhen: string;
}

const EVERY_TICK: Task[] = [
  { service: "forms", path: "sweep-uploads", quietWhen: '"found":0' },
  { service: "forms", path: "sweep-payments", quietWhen: '"deleted":0,"staleBookingHolds":0' },
];

const DAILY: Task = { service: "forms", path: "sweep-partials", quietWhen: '"deletedCount":0' };
const DAILY_HOUR_UTC = 3;
const HEALTH_EVERY_MINUTES = 5;

const INVOICE_EMAILS: Task = { service: "invoices", path: "scheduled-emails", quietWhen: '"sent":0,"failed":0' };
const INVOICE_EMAILS_EVERY_MINUTES = 5;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function baseFor(env: Env, service: Service): string {
  const base = service === "invoices" ? env.INVOICES_API_BASE ?? "" : env.FORMS_API_BASE;
  return base.replace(/\/$/, "");
}

async function callCronRoute(env: Env, task: Task): Promise<void> {
  const url = `${baseFor(env, task.service)}/api/cron/${task.path}`;

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

function tasksFor(env: Env, scheduledTime: number): Task[] {
  const at = new Date(scheduledTime);
  const tasks = [...EVERY_TICK];
  if (at.getUTCHours() === DAILY_HOUR_UTC && at.getUTCMinutes() === 0) tasks.push(DAILY);
  if (env.INVOICES_API_BASE && at.getUTCMinutes() % INVOICE_EMAILS_EVERY_MINUTES === 0) tasks.push(INVOICE_EMAILS);
  return tasks;
}

function isHealthTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() % HEALTH_EVERY_MINUTES === 0;
}

async function runSweeps(env: Env, tasks: Task[]): Promise<string[]> {
  const results = await Promise.allSettled(tasks.map((task) => callCronRoute(env, task)));
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason as Error).message);
}

function alertsFor(change: DownChange, sweepErrors: string[]): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  for (const service of change.newlyDown) {
    alerts.push({
      title: "Service down",
      where: service.name,
      detail: `${service.name} did not answer its health check twice in a row: ${service.reason}`,
      fields: [
        { label: "Checked URL", value: service.url },
        { label: "Result", value: service.reason },
      ],
    });
  }
  if (change.recovered.length) {
    alerts.push({
      title: "Service recovered",
      where: change.recovered.join(", "),
      detail: `${change.recovered.join(", ")} answering normally again.`,
    });
  }
  if (sweepErrors.length) {
    alerts.push({
      title: "Scheduled job failed",
      where: "Forms or Invoicing API · /api/cron",
      detail: sweepErrors.join("\n"),
      fields: [{ label: "Worker", value: "sweep-uploads-cron" }],
    });
  }
  return alerts;
}

async function runTick(env: Env, scheduledTime: number): Promise<void> {
  const healthTick = isHealthTick(scheduledTime);
  const [sweepErrors, down] = await Promise.all([
    runSweeps(env, tasksFor(env, scheduledTime)),
    healthTick ? failingServices(env) : Promise.resolve([]),
  ]);

  if (healthTick) {
    const quantalogUp = !down.some((d) => d.name === QUANTALOG_API);
    const change = await diffDownState(env, down);
    await Promise.all(alertsFor(change, sweepErrors).map((alert) => sendOpsAlert(env, alert, quantalogUp)));
  }
  if (sweepErrors.length) throw new Error(sweepErrors.join(" | "));
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.CRON_SECRET) {
      throw new Error("CRON_SECRET is not set — refusing to run");
    }

    ctx.waitUntil(runTick(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
