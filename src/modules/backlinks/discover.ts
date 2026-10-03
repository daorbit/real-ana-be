import { Event } from "../analytics/models/Event.js";
import { engineOf } from "../analytics/search-traffic.js";
import { urlMatchesDomain } from "../seo/seo.service.js";
import { cleanSourceUrl, hostOf } from "./domains.js";

export type ReferralSource = {
  sourceUrl: string;
  sourceDomain: string;
  landingPath: string;
  visits: number;
  lastAt: Date;
};

const WINDOW_DAYS = 90;
const MAX_REFERRERS = 600;
const MAX_SOURCES = 300;

const IGNORED_HOSTS = [
  /^localhost$/,
  /^\d{1,3}(\.\d{1,3}){3}$/,
  /(^|\.)mail\.google\.com$/,
  /(^|\.)outlook\.(live|office|office365)\.com$/,
  /^(web)?mail\./,
  /(^|\.)googleusercontent\.com$/,
  /(^|\.)translate\.goog$/,
  /(^|\.)accounts\.google\.com$/,
  /(^|\.)checkout\.stripe\.com$/,
];

function ignored(host: string): boolean {
  return IGNORED_HOSTS.some((re) => re.test(host));
}

export async function discoverReferrals(siteId: string, siteDomain: string): Promise<ReferralSource[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows: { _id: string; visits: number; lastAt: Date; path: string }[] = await Event.aggregate([
    { $match: { siteId, type: "pageview", ts: { $gte: since }, referrer: { $nin: ["", null] } } },
    { $group: { _id: "$referrer", visits: { $sum: 1 }, lastAt: { $max: "$ts" }, path: { $first: "$path" } } },
    { $sort: { visits: -1 } },
    { $limit: MAX_REFERRERS },
  ]);

  const merged = new Map<string, ReferralSource>();
  for (const row of rows) {
    const sourceUrl = cleanSourceUrl(row._id);
    if (!sourceUrl) continue;
    const host = hostOf(sourceUrl);
    if (!host || ignored(host) || engineOf(sourceUrl)) continue;
    if (siteDomain && urlMatchesDomain(sourceUrl, siteDomain)) continue;

    const prev = merged.get(sourceUrl);
    if (prev) {
      prev.visits += row.visits;
      if (row.lastAt > prev.lastAt) prev.lastAt = row.lastAt;
      continue;
    }
    merged.set(sourceUrl, {
      sourceUrl,
      sourceDomain: host,
      landingPath: row.path || "/",
      visits: row.visits,
      lastAt: row.lastAt,
    });
  }

  return [...merged.values()].sort((a, b) => b.visits - a.visits).slice(0, MAX_SOURCES);
}
