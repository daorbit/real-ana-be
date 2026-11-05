const DEFAULT_CRON_BUDGET_MS = 240_000;

export function cronDeadline(): () => boolean {
  const budget = Number(process.env.CRON_TIME_BUDGET_MS) || DEFAULT_CRON_BUDGET_MS;
  const stopAt = Date.now() + budget;
  return () => Date.now() >= stopAt;
}
