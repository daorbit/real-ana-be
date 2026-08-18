import type { PostFrequency } from "./models/ScheduledPost.js";

/**
 * Working out when a schedule next fires, in the user's own timezone.
 *
 * The report scheduler beside this one anchors every run to 08:00 UTC, which it
 * can do because reports do not let anyone choose a time. Posts do — they go out
 * publicly, and "9am on a Monday" means 9am where the author lives. So this has
 * to do the one thing the report version avoids: convert a wall-clock time in an
 * arbitrary IANA zone to a UTC instant, across daylight saving changes.
 *
 * It does that with `Intl` rather than a date library. Adding one for a single
 * conversion is not worth the dependency, and `Intl.DateTimeFormat` already
 * carries the full zone database the browser and Node ship with.
 */

/** Never schedule a run closer than this, whatever the arithmetic produces. */
const MIN_INTERVAL_MS = 60 * 1000;

export type ScheduleShape = {
  frequency: PostFrequency;
  hour: number;
  minute: number;
  timezone: string;
  /** 0-6, Sunday first. Weekly only. */
  weekday: number;
  /** 1-28. Monthly only. */
  dayOfMonth: number;
};

/**
 * What a UTC instant reads as on the wall clock in `timeZone`.
 *
 * `formatToParts` with an explicit zone is the supported way to ask this
 * question; the alternative — building a Date from a locale string — is
 * implementation-defined and does not survive every runtime.
 */
function partsInZone(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  // `hour12: false` yields 24 rather than 0 for midnight in some runtimes.
  if (out.hour === 24) out.hour = 0;
  return out as {
    year: number; month: number; day: number;
    hour: number; minute: number; second: number;
  };
}

/**
 * How far `timeZone` is from UTC at a given instant, in milliseconds.
 *
 * Derived by asking what the clock reads there and comparing it with the same
 * fields read as UTC. Computed per instant rather than once per zone, because
 * the answer changes across a daylight saving boundary.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Seconds are floored: the offset is what matters, not sub-second drift.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the clock in `timeZone` reads the given wall time.
 *
 * Solved by approximation and one correction: guess using the offset in force
 * near the target, then re-check the offset at that guess. The second pass is
 * what handles a wall time that sits on the far side of a DST transition from
 * the guess, where the first offset was the wrong one.
 *
 * A wall time that a DST jump skips entirely (02:30 on a spring-forward night)
 * has no exact instant; the correction lands just after the transition, which is
 * the conventional resolution and the one a reader would expect.
 */
function zonedTimeToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = new Date(naive - offsetMs(new Date(naive), timeZone));
  return new Date(naive - offsetMs(firstGuess, timeZone));
}

/** A zone string Intl will accept, falling back to UTC rather than throwing. */
function safeZone(timeZone: string): string {
  const zone = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    // A zone this runtime does not know. UTC keeps the schedule running rather
    // than failing every future computation for it.
    return "UTC";
  }
}

/**
 * When this schedule should next fire, strictly after `from`.
 *
 * Walks forward a day at a time from the current date in the user's zone,
 * returning the first candidate that matches the cadence and lies in the
 * future. Day-stepping rather than arithmetic on purpose: it makes the weekly
 * and monthly cases fall out of the same loop, and the search is bounded to a
 * couple of iterations for daily, seven for weekly, thirty-one for monthly.
 */
export function computeNextRun(schedule: ScheduleShape, from: Date = new Date()): Date {
  const zone = safeZone(schedule.timezone);
  const floor = new Date(from.getTime() + MIN_INTERVAL_MS);

  // Start from today's date as it reads in the user's zone, not the server's.
  const today = partsInZone(from, zone);

  // 400 days covers a monthly schedule from any starting point with room to
  // spare; the loop returns long before this in every real case.
  for (let i = 0; i < 400; i++) {
    const probe = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const y = probe.getUTCFullYear();
    const m = probe.getUTCMonth() + 1;
    const d = probe.getUTCDate();

    if (schedule.frequency === "weekly" && probe.getUTCDay() !== schedule.weekday) continue;
    if (schedule.frequency === "monthly" && d !== schedule.dayOfMonth) continue;

    const candidate = zonedTimeToUtc(y, m, d, schedule.hour, schedule.minute, zone);
    if (candidate >= floor) return candidate;
  }

  // Unreachable for any valid cadence. Rather than return nothing, push the
  // schedule a day out so a corrupt row cannot wedge the runner in a tight loop.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}
