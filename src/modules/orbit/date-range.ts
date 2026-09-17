
export type ParsedQuestionRange = {
  rangeKey: string;
  from?: string;
  to?: string;
  /** Human-readable, for the prompt's own prose ("Over last month, ..."). */
  label: string;
};

const DEFAULT: ParsedQuestionRange = { rangeKey: "7d", label: "the last 7 days" };

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfWeek(d: Date): Date {
  // Monday-start, matching the common dashboard convention.
  const copy = startOfDay(d);
  const day = copy.getDay();
  const diff = (day + 6) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

function custom(from: Date, to: Date, label: string): ParsedQuestionRange {
  return { rangeKey: "custom", from: from.toISOString(), to: to.toISOString(), label };
}

/**
 * Most-specific phrase wins when several appear — checked in order, first
 * match returned. "last week" is checked before a bare "week" would ever be
 * added, so extending this list should keep longer, more specific phrases
 * earlier.
 */
export function parseQuestionRange(question: string): ParsedQuestionRange {
  const q = ` ${question.toLowerCase()} `;
  const now = new Date();

  if (q.includes("yesterday")) {
    const end = startOfDay(now);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return custom(start, end, "yesterday");
  }

  if (q.includes("today")) {
    return { rangeKey: "24h", label: "today" };
  }

  if (q.includes("last week")) {
    const thisWeekStart = startOfWeek(now);
    const start = new Date(thisWeekStart);
    start.setDate(start.getDate() - 7);
    return custom(start, thisWeekStart, "last week");
  }

  if (q.includes("this week")) {
    return custom(startOfWeek(now), now, "this week");
  }

  if (q.includes("last month")) {
    const thisMonthStart = startOfMonth(now);
    const start = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() - 1, 1);
    return custom(start, thisMonthStart, "last month");
  }

  if (q.includes("this month")) {
    return custom(startOfMonth(now), now, "this month");
  }

  if (q.includes("last quarter")) {
    const thisQuarterStart = startOfQuarter(now);
    const start = new Date(thisQuarterStart.getFullYear(), thisQuarterStart.getMonth() - 3, 1);
    return custom(start, thisQuarterStart, "last quarter");
  }

  const nDays = /(?:last|past)\s+(\d{1,3})\s*days?|(\d{1,3})\s*days?/.exec(q);
  if (nDays) {
    const n = Number(nDays[1] ?? nDays[2]);
    if (Number.isFinite(n) && n > 0) {
      if (n === 7) return { rangeKey: "7d", label: "the last 7 days" };
      if (n === 30) return { rangeKey: "30d", label: "the last 30 days" };
      const end = now;
      const start = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
      return custom(start, end, `the last ${n} days`);
    }
  }

  return DEFAULT;
}
