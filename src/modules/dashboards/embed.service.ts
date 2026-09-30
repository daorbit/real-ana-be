import { customAlphabet } from "nanoid";
import { computeStats, resolveWindow } from "../analytics/stats.service.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";

type Stats = Awaited<ReturnType<typeof computeStats>>;
type Picker = (s: Stats) => Record<string, unknown>;

const series = (s: Stats) => ({ timeseries: s.timeseries });

const EMBED_FIELDS: Record<string, Picker> = {
  visitors: (s) => ({ visitors: s.visitors, deltas: { visitors: s.deltas.visitors }, ...series(s) }),
  pageviews: (s) => ({ pageviews: s.pageviews, deltas: { pageviews: s.deltas.pageviews }, ...series(s) }),
  sessions: (s) => ({ sessions: s.sessions, deltas: { sessions: s.deltas.sessions } }),
  live: (s) => ({ live: s.live }),
  bounce: (s) => ({ bounceRate: s.bounceRate, deltas: { bounceRate: s.deltas.bounceRate } }),
  avgSession: (s) => ({ avgSessionMs: s.avgSessionMs, deltas: { avgSessionMs: s.deltas.avgSessionMs } }),
  pagesPerSession: (s) => ({ pagesPerSession: s.pagesPerSession, deltas: { pagesPerSession: s.deltas.pagesPerSession } }),
  traffic: (s) => ({ pageviews: s.pageviews, ...series(s) }),
  worldMap: (s) => ({ countries: s.countries }),
  heatmap: (s) => ({ heatmap: s.heatmap }),
  topPages: (s) => ({ topPages: s.topPages }),
  entryPages: (s) => ({ entryPages: s.entryPages }),
  exitPages: (s) => ({ exitPages: s.exitPages }),
  topReferrers: (s) => ({ topReferrers: s.topReferrers }),
  topCountries: (s) => ({ countries: s.countries }),
  browsers: (s) => ({ browsers: s.browsers }),
  operatingSystems: (s) => ({ operatingSystems: s.operatingSystems }),
  devices: (s) => ({ devices: s.devices }),
  languages: (s) => ({ languages: s.languages }),
  channels: (s) => ({ channels: s.channels }),
  utmSources: (s) => ({ utmSources: s.utmSources }),
  utmCampaigns: (s) => ({ utmCampaigns: s.utmCampaigns }),
};

export const EMBEDDABLE_WIDGETS = Object.keys(EMBED_FIELDS);

export function isEmbeddable(widget: string): boolean {
  return Object.prototype.hasOwnProperty.call(EMBED_FIELDS, widget);
}

const makeToken = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 32);

export function newEmbedToken(): string {
  return `em_${makeToken()}`;
}

export function isEmbedTokenShape(token: string): boolean {
  return /^em_[0-9A-Za-z]{32}$/.test(token);
}

const statsCache = createTtlCache<Stats>(60_000, 500);

export async function embedPayload(widget: string, siteIds: string[], range: string) {
  const pick = EMBED_FIELDS[widget];
  if (!pick || siteIds.length === 0) return {};
  const key = `${range}:${[...siteIds].sort().join(",")}`;
  const stats = await statsCache(key, () => computeStats(siteIds, range, {}, resolveWindow(range)));
  return pick(stats);
}
