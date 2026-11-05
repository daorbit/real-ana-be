const DEFAULT_CRON_BUDGET_MS = 45_000;

export function cronDeadline(defaultMs = DEFAULT_CRON_BUDGET_MS): () => boolean {
  const budget = Number(process.env.CRON_TIME_BUDGET_MS) || defaultMs;
  const stopAt = Date.now() + budget;
  return () => Date.now() >= stopAt;
}
