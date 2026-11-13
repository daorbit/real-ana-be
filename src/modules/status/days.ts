export const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function lastDays(count: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, i) => dayKey(new Date(today - (count - 1 - i) * DAY_MS)));
}

export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + DAY_MS };
}
