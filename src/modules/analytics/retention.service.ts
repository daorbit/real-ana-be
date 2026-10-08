import { Site } from "./models/Site.js";
import { Event } from "./models/Event.js";
import { HeatmapClick } from "./models/HeatmapClick.js";
import { pooled } from "../../infra/http-client/safe-fetch.js";

export const EVENT_RETENTION_MONTHS = 25;
const SITE_CONCURRENCY = 4;

export function retentionCutoff(now = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - EVENT_RETENTION_MONTHS);
  return cutoff;
}

export async function sweepExpiredEvents() {
  const cutoff = retentionCutoff();
  const sites = await Site.find().select("siteId").lean();

  const [deletedPerSite, heatmap] = await Promise.all([
    pooled(sites, SITE_CONCURRENCY, async (site) => {
      const { deletedCount } = await Event.deleteMany({ siteId: site.siteId, ts: { $lt: cutoff } });
      return deletedCount;
    }),
    HeatmapClick.deleteMany({ ts: { $lt: cutoff } }),
  ]);

  return {
    cutoff: cutoff.toISOString(),
    sites: sites.length,
    events: deletedPerSite.reduce((sum, n) => sum + n, 0),
    heatmapClicks: heatmap.deletedCount,
  };
}
