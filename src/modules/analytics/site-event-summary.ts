import { Event } from "./models/Event.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";

export type SiteEventSummary = { eventCount: number; lastEventAt: Date | null };

const SUMMARY_TTL_MS = 5 * 60 * 1000;
const summaryCache = createTtlCache<SiteEventSummary>(SUMMARY_TTL_MS, 2_000);

async function loadSummary(siteId: string): Promise<SiteEventSummary> {
  const [eventCount, last] = await Promise.all([
    Event.countDocuments({ siteId }),
    Event.findOne({ siteId }).sort({ ts: -1 }).select("ts").lean<{ ts: Date }>(),
  ]);
  return { eventCount, lastEventAt: last?.ts ?? null };
}

export async function siteEventSummary(siteId: string): Promise<SiteEventSummary> {
  if (!(await Event.exists({ siteId }))) return { eventCount: 0, lastEventAt: null };
  return summaryCache(siteId, () => loadSummary(siteId));
}
