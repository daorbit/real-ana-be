import type { PipelineStage } from "mongoose";
import { Event } from "./models/Event.js";
import type { Window } from "./stats.service.js";
import {
  buildFunnelReport,
  TREND_UNIT_MS,
  trendUnitFor,
  type FunnelBucket,
  type FunnelReport,
  type FunnelStep,
  type FunnelTotals,
  type TrendUnit,
} from "./funnel-report.js";

const MAX_BUCKETS = 1000;

function stepCond(step: FunnelStep) {
  return step.type === "event"
    ? { $and: [{ $eq: ["$type", "custom"] }, { $eq: ["$name", step.value] }] }
    : { $and: [{ $eq: ["$type", "pageview"] }, { $eq: ["$path", step.value] }] };
}

function stepMatch(step: FunnelStep) {
  return step.type === "event" ? { type: "custom", name: step.value } : { type: "pageview", path: step.value };
}

const at = (field: string, i: number | string) => ({ $arrayElemAt: [field, i] });
const reachedAt = (i: number) => ({ $cond: [at("$flags", i), 1, 0] });

function sessionStages(siteIds: string[], steps: FunnelStep[], since: Date, until: Date): PipelineStage[] {
  const n = steps.length;
  return [
    { $match: { siteId: { $in: siteIds }, ts: { $gte: since, $lt: until }, $or: steps.map(stepMatch) } },
    {
      $group: Object.assign(
        { _id: "$sessionId" },
        ...steps.map((step, i) => ({ [`t${i}`]: { $min: { $cond: [stepCond(step), "$ts", null] } } })),
      ),
    },
    { $project: { times: steps.map((_s, i) => `$t${i}`) } },
    {
      $project: {
        times: 1,
        reached: {
          $reduce: {
            input: { $range: [0, n] },
            initialValue: { ok: true, prev: null, flags: [] },
            in: {
              $let: {
                vars: { t: at("$times", "$$this") },
                in: {
                  $let: {
                    vars: {
                      hit: {
                        $and: [
                          "$$value.ok",
                          { $ne: ["$$t", null] },
                          { $or: [{ $eq: ["$$value.prev", null] }, { $gte: ["$$t", "$$value.prev"] }] },
                        ],
                      },
                    },
                    in: {
                      ok: "$$hit",
                      prev: { $cond: ["$$hit", "$$t", "$$value.prev"] },
                      flags: { $concatArrays: ["$$value.flags", ["$$hit"]] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    { $project: { times: 1, flags: "$reached.flags" } },
    { $match: { "flags.0": true } },
  ];
}

function totalsStage(n: number): PipelineStage.FacetPipelineStage[] {
  const fields: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    fields[`s${i}`] = { $sum: reachedAt(i) };
    if (i > 0) {
      fields[`d${i}`] = {
        $avg: { $cond: [at("$flags", i), { $subtract: [at("$times", i), at("$times", i - 1)] }, null] },
      };
    }
  }
  return [{ $group: { _id: null, ...fields } }];
}

function trendStage(n: number, unit: TrendUnit): PipelineStage.FacetPipelineStage[] {
  const size = TREND_UNIT_MS[unit];
  const entryMs = { $toLong: at("$times", 0) };
  return [
    {
      $group: {
        _id: { $subtract: [entryMs, { $mod: [entryMs, size] }] },
        entered: { $sum: 1 },
        completed: { $sum: reachedAt(n - 1) },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_BUCKETS },
  ];
}

type FacetRow = {
  totals: Record<string, number | null>[];
  trend?: { _id: number; entered: number; completed: number }[];
};

async function runFunnel(
  siteIds: string[],
  steps: FunnelStep[],
  since: Date,
  until: Date,
  unit: TrendUnit | null,
): Promise<{ totals: FunnelTotals; buckets: FunnelBucket[] }> {
  const n = steps.length;
  const facet: Record<string, PipelineStage.FacetPipelineStage[]> = { totals: totalsStage(n) };
  if (unit) facet.trend = trendStage(n, unit);

  const [row] = await Event.aggregate<FacetRow>([...sessionStages(siteIds, steps, since, until), { $facet: facet }]);
  const raw = row?.totals?.[0] ?? {};

  return {
    totals: {
      counts: steps.map((_s, i) => Number(raw[`s${i}`] ?? 0)),
      avgMsFromPrev: steps.map((_s, i) => (i === 0 || raw[`d${i}`] == null ? null : Number(raw[`d${i}`]))),
    },
    buckets: (row?.trend ?? []).map((b) => ({ at: Number(b._id), entered: b.entered, completed: b.completed })),
  };
}

export async function computeFunnelReport(
  siteIds: string[],
  steps: FunnelStep[],
  win: Window,
  compare: boolean,
): Promise<FunnelReport> {
  const unit = trendUnitFor(win.windowMs);
  const [current, previous] = await Promise.all([
    runFunnel(siteIds, steps, win.since, win.until, unit),
    compare ? runFunnel(siteIds, steps, win.prevSince, win.prevUntil, null) : Promise.resolve(null),
  ]);

  return buildFunnelReport({
    steps,
    current: current.totals,
    previous: previous?.totals ?? null,
    buckets: current.buckets,
    window: win,
    unit,
  });
}
