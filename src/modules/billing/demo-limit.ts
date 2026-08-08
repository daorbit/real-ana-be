/**
 * Per-address demo throttling.
 *
 * Backed by the `DemoStart` collection rather than process memory: the API runs
 * serverless, so a `Map` in this module is only ever seen by the one instance
 * that wrote it — the next request lands somewhere cold, sees no history, and
 * the limit lets it straight through. Anything that has to hold across requests
 * has to be shared state.
 *
 * No address is stored. Callers are counted by an HMAC of the address keyed by
 * the server secret (see `DemoStart`), and the rows expire on their own after
 * the window.
 */

import crypto from "crypto";
import { DemoStart } from "./models/DemoStart.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Key the hash with the server secret so a leaked database can't be walked
 * back to addresses by hashing candidate IPs — an unkeyed digest of a value
 * from a space this small is trivially reversible.
 */
function hashIp(ip: string): string {
  const secret = process.env.JWT_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

export type DemoAttempt =
  | { allowed: true }
  | { allowed: false; retryAt: Date };

/**
 * Record an attempt from `ip` and say whether it may proceed.
 *
 * A refusal is written too — the admin summary reports how often the limit
 * bites — but refusals are not counted toward the limit itself, so a blocked
 * visitor retrying doesn't push their own reset further away every time.
 */
export async function tryStartDemo(ip: string, limit: number): Promise<DemoAttempt> {
  const ipHash = hashIp(ip);
  const since = new Date(Date.now() - WINDOW_MS);

  const mine = await DemoStart.find({ ipHash, allowed: true, createdAt: { $gt: since } })
    .sort({ createdAt: 1 })
    .select("createdAt")
    .lean();

  if (mine.length >= limit) {
    await DemoStart.create({ ipHash, allowed: false });
    // The oldest start in the window is the one that has to age out.
    const oldest = mine[0].createdAt as Date;
    return { allowed: false, retryAt: new Date(oldest.getTime() + WINDOW_MS) };
  }

  await DemoStart.create({ ipHash, allowed: true });
  return { allowed: true };
}

/** What the admin summary reports. No addresses leave this module. */
export async function demoUsageSnapshot() {
  const since = new Date(Date.now() - WINDOW_MS);

  const [started, blocked, distinct] = await Promise.all([
    DemoStart.countDocuments({ allowed: true, createdAt: { $gt: since } }),
    DemoStart.countDocuments({ allowed: false, createdAt: { $gt: since } }),
    DemoStart.distinct("ipHash", { allowed: true, createdAt: { $gt: since } }),
  ]);

  return {
    /** Demo starts in the last 24 hours, across all addresses. */
    today: started,
    /** Distinct addresses with a start in the last 24 hours. */
    activeIps: distinct.length,
    /** Attempts the limit turned away in the same window. */
    blocked: blocked,
    /** Start of the window these figures cover. */
    since: since.toISOString(),
  };
}
