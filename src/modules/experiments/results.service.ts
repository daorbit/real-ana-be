import { Event } from "../analytics/models/Event.js";
import { stepMatch } from "../analytics/funnel.service.js";
import type { FunnelStep } from "../analytics/funnel-report.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { summarize, type ResultsSummary } from "./experiment-stats.js";

const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const CACHE_BUCKET_MS = 60_000;

export type ExperimentResultsInput = {
  id: string;
  siteId: string;
  goal: FunnelStep;
  variants: { key: string; name: string }[];
  startedAt: Date | null;
  endedAt: Date | null;
};

export type ExperimentResults = ResultsSummary & { since: Date | null; until: Date | null };

const cache = createTtlCache<ExperimentResults>(60_000, 500);

async function countByVariant(input: ExperimentResultsInput, since: Date, until: Date) {
  return Event.aggregate<{ _id: string | null; sessions: number; conversions: number }>([
    {
      $match: {
        siteId: input.siteId,
        ts: { $gte: since, $lt: until },
        $or: [{ type: "experiment", name: "expose", "props.experimentId": input.id }, stepMatch(input.goal)],
      },
    },
    { $project: { sessionId: 1, ts: 1, exposure: { $eq: ["$type", "experiment"] }, variant: "$props.variant" } },
    {
      $group: {
        _id: "$sessionId",
        exposedAt: { $min: { $cond: ["$exposure", "$ts", null] } },
        variants: { $addToSet: { $cond: ["$exposure", "$variant", "$$REMOVE"] } },
        lastGoal: { $max: { $cond: ["$exposure", null, "$ts"] } },
      },
    },
    { $match: { exposedAt: { $ne: null } } },
    {
      $project: {
        variant: { $arrayElemAt: ["$variants", 0] },
        converted: { $cond: [{ $and: [{ $ne: ["$lastGoal", null] }, { $gte: ["$lastGoal", "$exposedAt"] }] }, 1, 0] },
      },
    },
    { $group: { _id: "$variant", sessions: { $sum: 1 }, conversions: { $sum: "$converted" } } },
  ]);
}

export function experimentResults(input: ExperimentResultsInput): Promise<ExperimentResults> {
  const empty = (): ExperimentResults => ({
    ...summarize(input.variants.map((v) => ({ ...v, sessions: 0, conversions: 0 }))),
    since: input.startedAt,
    until: input.endedAt,
  });
  if (!input.startedAt) return Promise.resolve(empty());

  const until = input.endedAt ?? new Date(Math.ceil(Date.now() / CACHE_BUCKET_MS) * CACHE_BUCKET_MS);
  const since = new Date(Math.max(input.startedAt.getTime(), until.getTime() - MAX_WINDOW_MS));
  const key = [input.id, input.goal.type, input.goal.value, since.toISOString(), until.toISOString()].join(":");

  return cache(key, async () => {
    const rows = await countByVariant(input, since, until);
    const byKey = new Map(rows.map((r) => [String(r._id ?? ""), r]));
    const counts = input.variants.map((v) => ({
      key: v.key,
      name: v.name,
      sessions: byKey.get(v.key)?.sessions ?? 0,
      conversions: byKey.get(v.key)?.conversions ?? 0,
    }));
    return { ...summarize(counts), since, until };
  });
}
