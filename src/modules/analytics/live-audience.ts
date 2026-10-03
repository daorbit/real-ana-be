import { Event } from "./models/Event.js";
import type { TrafficKind } from "./bot-detect.js";

export type LiveVisitor = {
  id: string;
  kind: TrafficKind;
  verified: boolean;
  name: string;
  signals: string[];
  path: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  pageviews: number;
  firstSeen: Date;
  lastSeen: Date;
};

export type LiveAudience = {
  total: number;
  humans: number;
  confirmedHumans: number;
  likelyHumans: number;
  bots: number;
  ai: number;
  crawlers: number;
  automation: number;
  suspect: number;
  visitors: LiveVisitor[];
};

type Row = {
  _id: string;
  path: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  firstSeen: Date;
  lastSeen: Date;
  kinds: TrafficKind[];
  names: string[];
  signals: (string[] | null)[];
  interacted: number;
  pageviews: number;
};

const PRIORITY: TrafficKind[] = ["ai", "automation", "crawler", "suspect", "human"];
const MAX_VISITORS = 50;

export const EMPTY_AUDIENCE: LiveAudience = {
  total: 0,
  humans: 0,
  confirmedHumans: 0,
  likelyHumans: 0,
  bots: 0,
  ai: 0,
  crawlers: 0,
  automation: 0,
  suspect: 0,
  visitors: [],
};

function toVisitor(row: Row): LiveVisitor {
  const kind = PRIORITY.find((k) => row.kinds.includes(k)) ?? "human";
  return {
    id: String(row._id ?? "").slice(0, 8),
    kind,
    verified: kind === "human" && row.interacted > 0,
    name: row.names.find((n) => n) ?? "",
    signals: [...new Set(row.signals.flatMap((s) => s ?? []))],
    path: row.path || "/",
    country: row.country || "unknown",
    device: row.device || "unknown",
    browser: row.browser || "unknown",
    os: row.os || "unknown",
    pageviews: row.pageviews,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
  };
}

export async function computeLiveAudience(
  siteIds: string[],
  since: Date,
  match: Record<string, unknown> = {}
): Promise<LiveAudience> {
  if (!siteIds.length) return EMPTY_AUDIENCE;

  const rows: Row[] = await Event.aggregate([
    { $match: { siteId: { $in: siteIds }, ts: { $gte: since }, ...match } },
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: "$visitorHash",
        path: { $first: "$path" },
        country: { $first: "$country" },
        device: { $first: "$device" },
        browser: { $first: "$browser" },
        os: { $first: "$os" },
        lastSeen: { $first: "$ts" },
        firstSeen: { $last: "$ts" },
        kinds: { $addToSet: { $ifNull: ["$traffic.kind", "human"] } },
        names: { $addToSet: { $ifNull: ["$traffic.name", ""] } },
        signals: { $addToSet: "$traffic.signals" },
        interacted: { $max: { $cond: [{ $eq: ["$type", "interact"] }, 1, 0] } },
        pageviews: { $sum: { $cond: [{ $eq: ["$type", "pageview"] }, 1, 0] } },
      },
    },
  ]);

  const visitors = rows.map(toVisitor);
  const count = (kind: TrafficKind) => visitors.filter((v) => v.kind === kind).length;
  const humans = count("human");
  const confirmedHumans = visitors.filter((v) => v.verified).length;
  const ai = count("ai");
  const crawlers = count("crawler");
  const automation = count("automation");

  return {
    total: visitors.length,
    humans,
    confirmedHumans,
    likelyHumans: humans - confirmedHumans,
    bots: ai + crawlers + automation,
    ai,
    crawlers,
    automation,
    suspect: count("suspect"),
    visitors: visitors
      .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
      .slice(0, MAX_VISITORS),
  };
}
