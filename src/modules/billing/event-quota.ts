import { Subscription } from "./models/Subscription.js";
import { Site } from "../analytics/models/Site.js";
import { getPlanCatalogEntry } from "./plans.catalog.js";


const DECISION_TTL_MS = 60_000;

type Decision = {
  workspaceId: string | null;
  allowed: boolean;
  checkedAt: number;
};

const decisions = new Map<string, Decision>();


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

  // A lapsed period drops to Free rather than stopping ingest: the tracker on
  // the customer's site has no idea about billing and keeps sending, so cutting
  // off entirely just puts an unexplained hole in their history. Free's
  // allowance is the floor until they renew.
  const end = sub.get("currentPeriodEnd") as Date | null;
  const expired = end ? end.getTime() < Date.now() : true;

  const slug = expired ? "free" : (sub.get("planSlug") as string);
  const plan = getPlanCatalogEntry(slug);
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
  // `eventsUsed` is now current as of the last ingest rather than as of the
  // last flush, so the allowance needs no in-flight buffer subtracted from it.
  const remaining = (await allowanceFor(workspaceId)) ?? 0;
  const allowed = remaining > 0;

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

/**
 * Count ingested events against their workspace.
 *
 * Written on the request that ingested them rather than buffered for a later
 * flush. Buffering assumed a process that stays alive to do the flushing, and
 * this one does not: each request is a serverless invocation that can be frozen
 * the moment its response goes out, taking any counts still in memory with it.
 * Every workspace was under-billed as a result, by whatever share of its traffic
 * happened to arrive on instances that never reached a flush threshold.
 *
 * One `$inc` per request, not per event — the collector counts a whole batch at
 * once — so this costs a fraction of a write per beacon, not one each.
 */
export async function countEvents(workspaceId: string, n = 1): Promise<void> {
  if (n <= 0) return;
  try {
    await Subscription.updateOne({ workspaceId }, { $inc: { eventsUsed: n } });
  } catch (e) {
    // Usage is not worth failing an ingest over: the events are already stored,
    // and refusing the beacon would have the tracker drop them for a billing
    // problem the visitor's browser cannot do anything about.
    console.error("[event-quota] usage increment failed:", (e as Error).message);
  }
}

export function invalidateSite(siteId: string) {
  decisions.delete(siteId);
}
