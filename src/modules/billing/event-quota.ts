import { Subscription } from "./models/Subscription.js";
import { Site } from "../analytics/models/Site.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";

/**
 * Event ingest metering.
 *
 * Every other quota in this codebase spends one unit per action with a
 * conditional write, which is right for audits and crawls: they are rare,
 * expensive, and worth a round trip to get exactly right. Events are the
 * opposite — thousands per second from anonymous browsers, on the one path in
 * the product where latency is visible to the customer's visitors.
 *
 * So this module trades exactness for throughput, deliberately:
 *
 * - The allowance decision is cached per site for a short window, so the common
 *   case (a site well inside its quota) costs no database read at all.
 * - Usage is counted in memory and flushed periodically, so N events cost one
 *   write instead of N.
 *
 * The cost of that trade is overshoot: a workspace can exceed its quota by
 * roughly (cache TTL x arrival rate) before ingest stops. That is the correct
 * direction to be wrong. Over-counting would drop events a customer is entitled
 * to and can never be recovered; under-counting briefly costs us a few writes
 * we would have taken anyway, and the next flush corrects it.
 */

/** How long a site's allow/deny decision is trusted before re-reading it. */
const DECISION_TTL_MS = 60_000;

/** How often buffered usage is written back. */
const FLUSH_INTERVAL_MS = 10_000;

/** Cached per-site decision, keyed by the public siteId. */
type Decision = {
  workspaceId: string | null;
  /** False once the workspace is over quota; ingest is refused until re-checked. */
  allowed: boolean;
  checkedAt: number;
};

const decisions = new Map<string, Decision>();

/** Events counted but not yet written back, keyed by workspaceId. */
const pending = new Map<string, number>();

/**
 * Bound the decision cache.
 *
 * siteId comes off an unauthenticated request, and an unknown one is cached as
 * a rejection (which is what stops a flood of junk keys from hitting the
 * database on every event). That means the key space is attacker-controlled, so
 * it needs a ceiling — without one this map is a memory leak with a public
 * endpoint in front of it.
 */
const MAX_DECISIONS = 10_000;

function remember(siteId: string, decision: Decision) {
  // Evicting the oldest insertion is enough here: entries are short-lived by
  // TTL anyway, and this only has to stop unbounded growth, not be an LRU.
  if (decisions.size >= MAX_DECISIONS) {
    const oldest = decisions.keys().next().value;
    if (oldest !== undefined) decisions.delete(oldest);
  }
  decisions.set(siteId, decision);
}

/**
 * The event allowance for a workspace this cycle, or null when it has no live
 * plan at all.
 *
 * A lapsed paid plan returns null rather than falling back to Free's allowance:
 * ingest is the one thing that must not silently keep running for free after a
 * subscription ends.
 */
async function allowanceFor(workspaceId: string): Promise<number | null> {
  const sub = await Subscription.findOne({ workspaceId }).select(
    "planSlug currentPeriodEnd eventsUsed",
  );
  if (!sub) return null;

  const end = sub.get("currentPeriodEnd") as Date | null;
  if (end && end.getTime() < Date.now()) return null;

  const plan = getPlanCatalogEntry(sub.get("planSlug") as string);
  if (!plan) return null;

  const used = (sub.get("eventsUsed") as number) ?? 0;
  return plan.monthlyEventQuota - used;
}

/**
 * Whether this site may ingest right now, and the workspace to bill it to.
 *
 * Returns the workspace so the caller can count the event without a second
 * lookup. A null workspace means the site is unknown — cached like any other
 * decision so repeated junk keys stay cheap.
 */
export async function canIngest(
  siteId: string,
): Promise<{ allowed: boolean; workspaceId: string | null }> {
  const now = Date.now();
  const cached = decisions.get(siteId);
  if (cached && now - cached.checkedAt < DECISION_TTL_MS) {
    return { allowed: cached.allowed, workspaceId: cached.workspaceId };
  }

  const site = await Site.findOne({ siteId }).select("workspaceId");
  if (!site) {
    remember(siteId, { workspaceId: null, allowed: false, checkedAt: now });
    return { allowed: false, workspaceId: null };
  }

  const workspaceId = String(site.get("workspaceId"));
  // Anything already buffered has not reached the stored counter yet, so it has
  // to be subtracted here — otherwise a burst inside one flush interval would
  // keep reading its remaining allowance as though none of it had been spent.
  const remaining = (await allowanceFor(workspaceId)) ?? 0;
  const allowed = remaining - (pending.get(workspaceId) ?? 0) > 0;

  remember(siteId, { workspaceId, allowed, checkedAt: now });
  return { allowed, workspaceId };
}

/** Count one ingested event against its workspace. Buffered; see `flush`. */
export function countEvent(workspaceId: string) {
  pending.set(workspaceId, (pending.get(workspaceId) ?? 0) + 1);
}

/**
 * Write buffered counts back and clear the buffer.
 *
 * Takes the buffer first and writes after, so events arriving mid-flush land in
 * the next batch rather than being dropped. A failed write puts the counts back
 * rather than losing them — usage that vanishes on a transient database blip is
 * quota the customer silently gets for free.
 */
export async function flushEventUsage(): Promise<void> {
  if (pending.size === 0) return;

  const batch = [...pending.entries()];
  pending.clear();

  await Promise.all(
    batch.map(async ([workspaceId, count]) => {
      try {
        await Subscription.updateOne({ workspaceId }, { $inc: { eventsUsed: count } });
      } catch {
        pending.set(workspaceId, (pending.get(workspaceId) ?? 0) + count);
      }
    }),
  );
}

/**
 * Start the periodic flush.
 *
 * Only for a long-running host. On Vercel the process is frozen the moment a
 * response goes out and a timer will never fire, so serverless flushes from the
 * request path instead — see `maybeFlush`.
 */
export function startEventUsageFlush(): NodeJS.Timeout {
  const timer = setInterval(() => {
    flushEventUsage().catch((e) => console.error("[event-quota] flush failed:", e));
  }, FLUSH_INTERVAL_MS);
  // Do not hold the process open for this alone.
  timer.unref?.();
  return timer;
}

let lastFlush = Date.now();

/**
 * Flush if enough time has passed, from inside a request.
 *
 * The serverless counterpart to the timer above. Awaited by the caller rather
 * than fired and forgotten: on a frozen-after-response platform, an unawaited
 * write is a write that may never happen.
 */
export async function maybeFlush(): Promise<void> {
  if (Date.now() - lastFlush < FLUSH_INTERVAL_MS) return;
  lastFlush = Date.now();
  await flushEventUsage();
}

/** Drop a site's cached decision, so the next event re-reads it. */
export function invalidateSite(siteId: string) {
  decisions.delete(siteId);
}
