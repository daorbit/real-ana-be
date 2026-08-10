import { Subscription } from "./models/Subscription.js";
import { Site } from "../analytics/models/Site.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";


const DECISION_TTL_MS = 60_000;

/** How often buffered usage is written back. */
const FLUSH_INTERVAL_MS = 10_000;

type Decision = {
  workspaceId: string | null;
  allowed: boolean;
  checkedAt: number;
};

const decisions = new Map<string, Decision>();

const pending = new Map<string, number>();


const MAX_DECISIONS = 10_000;

function remember(siteId: string, decision: Decision) {
  if (decisions.size >= MAX_DECISIONS) {
    const oldest = decisions.keys().next().value;
    if (oldest !== undefined) decisions.delete(oldest);
  }
  decisions.set(siteId, decision);
}


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
  const remaining = (await allowanceFor(workspaceId)) ?? 0;
  const allowed = remaining - (pending.get(workspaceId) ?? 0) > 0;

  remember(siteId, { workspaceId, allowed, checkedAt: now });

  if (!allowed) denyWorkspace(workspaceId, now);

  return { allowed, workspaceId };
}

function denyWorkspace(workspaceId: string, at: number) {
  for (const [id, d] of decisions) {
    if (d.workspaceId === workspaceId && d.allowed) {
      decisions.set(id, { ...d, allowed: false, checkedAt: at });
    }
  }
}

/** Count one ingested event against its workspace. Buffered; see `flush`. */
export function countEvent(workspaceId: string) {
  pending.set(workspaceId, (pending.get(workspaceId) ?? 0) + 1);
}

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

export function startEventUsageFlush(): NodeJS.Timeout {
  const timer = setInterval(() => {
    flushEventUsage().catch((e) => console.error("[event-quota] flush failed:", e));
  }, FLUSH_INTERVAL_MS);
  // Do not hold the process open for this alone.
  timer.unref?.();
  return timer;
}

let lastFlush = Date.now();

const MAX_BUFFERED = 200;

function bufferedTotal(): number {
  let n = 0;
  for (const c of pending.values()) n += c;
  return n;
}

export async function maybeFlush(): Promise<void> {
  const due = Date.now() - lastFlush >= FLUSH_INTERVAL_MS;
  if (!due && bufferedTotal() < MAX_BUFFERED) return;
  lastFlush = Date.now();
  await flushEventUsage();
}

export function invalidateSite(siteId: string) {
  decisions.delete(siteId);
}
