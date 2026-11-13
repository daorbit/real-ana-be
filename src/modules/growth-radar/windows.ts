export const DAY_MS = 24 * 60 * 60 * 1000;

export type DayWindow = {
  since: Date;
  until: Date;
  prevSince: Date;
  prevUntil: Date;
  days: number;
};

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function completeDays(days: number, now = new Date()): DayWindow {
  const until = startOfUtcDay(now);
  const since = new Date(until.getTime() - days * DAY_MS);
  return {
    since,
    until,
    prevSince: new Date(since.getTime() - days * DAY_MS),
    prevUntil: since,
    days,
  };
}

export function rangeFor(days: number, now = new Date()) {
  const until = new Date(now);
  const sinceDay = startOfUtcDay(now);
  const since = new Date(sinceDay.getTime() - (days - 1) * DAY_MS);
  return { since, until, prevSince: new Date(since.getTime() - days * DAY_MS), prevUntil: since, days };
}

export function nextScanAfter(date: Date, hourUtc: number): Date {
  const next = startOfUtcDay(date);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= date.getTime()) next.setTime(next.getTime() + DAY_MS);
  return next;
}
