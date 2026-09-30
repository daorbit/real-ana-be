import { Site } from "../analytics/models/Site.js";
import { createTtlCache } from "../../shared/utils/ttl-cache.js";
import { GoalTarget, TARGET_METRICS, TARGET_PERIODS, type TargetMetric, type TargetPeriod } from "./models/GoalTarget.js";
import { periodWindow } from "./period.js";
import { readMetric, type MetricReading } from "./target-metrics.js";

type TargetDoc = InstanceType<typeof GoalTarget>;

export type TargetDraft = {
  name: string;
  metric: TargetMetric;
  target: number;
  period: TargetPeriod;
  siteId: string;
  goalId: string | null;
};

const LOWER_IS_BETTER: TargetMetric[] = ["searchPosition"];

const cache = createTtlCache<MetricReading>(60_000);

export function parseTargetDraft(body: unknown): TargetDraft | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = String(b.name ?? "").trim().slice(0, 80);
  const metric = String(b.metric ?? "") as TargetMetric;
  const period = String(b.period ?? "month") as TargetPeriod;
  const target = Number(b.target);

  if (!name) return "name required";
  if (!TARGET_METRICS.includes(metric)) return "unknown metric";
  if (!TARGET_PERIODS.includes(period)) return "period must be month or quarter";
  if (!Number.isFinite(target) || target <= 0 || target > 1e12) return "target must be a positive number";

  const goalId = metric === "conversions" ? String(b.goalId ?? "").trim() || null : null;
  if (metric === "conversions" && !goalId) return "pick the conversion goal to count";

  return {
    name,
    metric,
    period,
    target: metric === "searchPosition" ? Math.round(target * 10) / 10 : Math.round(target),
    siteId: String(b.siteId ?? "").trim().slice(0, 64),
    goalId,
  };
}

function progressOf(metric: TargetMetric, value: number, target: number): number {
  if (LOWER_IS_BETTER.includes(metric)) return value <= 0 ? 0 : Math.min(1, target / value);
  return Math.min(1, value / target);
}

export async function targetProgress(target: TargetDoc, siteIds: string[]) {
  const metric = target.get("metric") as TargetMetric;
  const goal = target.get("target") as number;
  const period = periodWindow(target.get("period") as TargetPeriod);
  const siteId = (target.get("siteId") as string) ?? "";
  const scoped = siteId ? siteIds.filter((id) => id === siteId) : siteIds;
  const goalId = target.get("goalId") ? String(target.get("goalId")) : null;

  const reading = await cache(
    `${target.id}:${metric}:${siteId}:${goalId}:${period.key}`,
    () =>
      readMetric(
        { workspaceId: String(target.get("workspaceId")), metric, siteIds: scoped, siteId, goalId },
        period,
      ),
  );

  const lowerIsBetter = LOWER_IS_BETTER.includes(metric);
  const base = {
    id: target.id,
    name: target.get("name") as string,
    metric,
    target: goal,
    period: target.get("period") as TargetPeriod,
    siteId,
    goalId,
    direction: lowerIsBetter ? ("below" as const) : ("above" as const),
    periodKey: period.key,
    periodLabel: period.label,
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    elapsed: Math.round(period.elapsed * 1000) / 1000,
    daysLeft: period.daysLeft,
  };

  if (reading.status === "unavailable") {
    return { ...base, status: "unavailable" as const, reason: reading.reason, current: null, progress: 0, achieved: false, projected: null };
  }

  const achieved = lowerIsBetter ? reading.value > 0 && reading.value <= goal : reading.value >= goal;
  const projected =
    lowerIsBetter || period.elapsed < 0.05 ? null : Math.round(reading.value / period.elapsed);

  return {
    ...base,
    status: "ok" as const,
    reason: null,
    current: reading.value,
    windowLabel: reading.windowLabel ?? period.label,
    progress: Math.round(progressOf(metric, reading.value, goal) * 1000) / 1000,
    achieved,
    projected,
  };
}

export async function workspaceTargets(workspaceId: string) {
  const [targets, sites] = await Promise.all([
    GoalTarget.find({ workspaceId }).sort({ createdAt: 1 }),
    Site.find({ workspaceId }).select("siteId"),
  ]);
  const siteIds = sites.map((s) => String(s.siteId));
  return Promise.all(targets.map((t) => targetProgress(t, siteIds)));
}
