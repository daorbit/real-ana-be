import type { Factors, Level } from "./types.js";

const POINTS: Record<Level, number> = { high: 3, medium: 2, low: 1 };
const LABEL: Record<Level, string> = { high: "High", medium: "Medium", low: "Low" };

export const PRIORITY_RANK: Record<Level, number> = POINTS;

export function levelAtLeast(value: number, high: number, medium: number): Level {
  if (value >= high) return "high";
  if (value >= medium) return "medium";
  return "low";
}

export function prioritise(factors: Factors): { priority: Level; rank: number; reason: string } {
  const score = POINTS[factors.impact.level] + POINTS[factors.confidence.level] + POINTS[factors.urgency.level];
  let priority: Level = score >= 8 ? "high" : score >= 6 ? "medium" : "low";
  if (factors.confidence.level === "low" && priority === "high") priority = "medium";
  const reason = `${LABEL[priority]} priority: ${[factors.impact.reason, factors.confidence.reason, factors.urgency.reason]
    .filter(Boolean)
    .join(" ")}`;
  return { priority, rank: POINTS[priority], reason };
}
