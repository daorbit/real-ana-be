/**
 * Per-address demo throttling, held in memory.
 *
 * Nothing about a demo visitor is written to the database: the only state is a
 * list of recent start times per address, kept in this process and dropped as
 * soon as it ages past the window. That means no IPs at rest, nothing to expire
 * or purge, and no personal data accumulating for a feature that only needs to
 * answer "has this address had its three goes today?".
 *
 * The trade-off is deliberate: process memory does not survive a restart and is
 * not shared between instances, so the limit is best-effort rather than exact.
 * For discouraging casual repeat visits — which is what this is for — that is
 * the right side of the trade.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Start times per address, newest last. Pruned on every read. */
const starts = new Map<string, number[]>();

/** Counters for the admin summary. Reset when the process does. */
const totals = { started: 0, blocked: 0, since: Date.now() };

/** Drop anything older than the window, and forget addresses with nothing left. */
function recent(ip: string, now: number): number[] {
  const cutoff = now - WINDOW_MS;
  const kept = (starts.get(ip) ?? []).filter((t) => t > cutoff);
  if (kept.length) starts.set(ip, kept);
  else starts.delete(ip);
  return kept;
}

/**
 * Sweep every address occasionally so one-off visitors don't sit in the map
 * forever. Cheap: the map only ever holds addresses seen in the last day.
 */
function sweep(now: number) {
  for (const ip of [...starts.keys()]) recent(ip, now);
}
let lastSweep = Date.now();

export type DemoAttempt =
  | { allowed: true }
  | { allowed: false; retryAt: Date };

/**
 * Record an attempt from `ip` and say whether it may proceed.
 *
 * A refusal is counted for the admin summary but does not extend the window —
 * otherwise a blocked visitor retrying would push their own reset further away
 * every time.
 */
export function tryStartDemo(ip: string, limit: number): DemoAttempt {
  const now = Date.now();
  if (now - lastSweep > WINDOW_MS / 24) {
    sweep(now);
    lastSweep = now;
  }

  const mine = recent(ip, now);
  if (mine.length >= limit) {
    totals.blocked++;
    // The oldest start in the window is the one that has to age out.
    return { allowed: false, retryAt: new Date(mine[0] + WINDOW_MS) };
  }

  mine.push(now);
  starts.set(ip, mine);
  totals.started++;
  return { allowed: true };
}

/** What the admin summary reports. No addresses leave this module. */
export function demoUsageSnapshot() {
  const now = Date.now();
  sweep(now);
  let activeStarts = 0;
  for (const times of starts.values()) activeStarts += times.length;
  return {
    /** Demo starts in the last 24 hours, across all addresses. */
    today: activeStarts,
    /** Distinct addresses with a start in the last 24 hours. */
    activeIps: starts.size,
    /** Totals since this server process started. */
    startedSinceBoot: totals.started,
    blockedSinceBoot: totals.blocked,
    since: new Date(totals.since).toISOString(),
  };
}
