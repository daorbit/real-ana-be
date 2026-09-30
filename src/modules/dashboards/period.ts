import type { TargetPeriod } from "./models/GoalTarget.js";

export type PeriodWindow = {
  key: string;
  label: string;
  start: Date;
  end: Date;
  elapsed: number;
  daysLeft: number;
  months: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function periodWindow(period: TargetPeriod, now = new Date()): PeriodWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstMonth = period === "quarter" ? Math.floor(month / 3) * 3 : month;
  const length = period === "quarter" ? 3 : 1;

  const start = new Date(Date.UTC(year, firstMonth, 1));
  const end = new Date(Date.UTC(year, firstMonth + length, 1));
  const span = end.getTime() - start.getTime();
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));

  const months = Array.from({ length }, (_, i) => monthKey(year, firstMonth + i));
  const quarter = Math.floor(firstMonth / 3) + 1;

  return {
    key: period === "quarter" ? `${year}-Q${quarter}` : monthKey(year, month),
    label: period === "quarter" ? `Q${quarter} ${year}` : `${MONTH_NAMES[month]} ${year}`,
    start,
    end,
    elapsed,
    daysLeft: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS)),
    months,
  };
}
