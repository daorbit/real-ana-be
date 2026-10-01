import { Dashboard } from "../dashboards/models/Dashboard.js";
import { Embed } from "../dashboards/models/Embed.js";
import { GoalTarget } from "../dashboards/models/GoalTarget.js";
import { Goal } from "../analytics/models/Goal.js";
import type { PlanCatalogEntry } from "./plans.catalog.js";

export type CountedFeature = "dashboards" | "embeds" | "goalTargets" | "conversionGoals";

type FeatureSpec = {
  kind: string;
  label: string;
  noun: string;
  plural: string;
  limit: (plan: PlanCatalogEntry) => number;
  count: (workspaceId: string) => Promise<number>;
};

export const COUNTED_FEATURES: Record<CountedFeature, FeatureSpec> = {
  dashboards: {
    kind: "dashboards",
    label: "Dashboards",
    noun: "custom dashboard",
    plural: "custom dashboards",
    limit: (p) => p.maxDashboards,
    count: (workspaceId) => Dashboard.countDocuments({ workspaceId }),
  },
  embeds: {
    kind: "embeds",
    label: "Embedded widgets",
    noun: "embedded widget",
    plural: "embedded widgets",
    limit: (p) => p.maxEmbeds,
    count: (workspaceId) => Embed.countDocuments({ workspaceId }),
  },
  goalTargets: {
    kind: "goal_targets",
    label: "Goal targets",
    noun: "goal target",
    plural: "goal targets",
    limit: (p) => p.maxGoalTargets,
    count: (workspaceId) => GoalTarget.countDocuments({ workspaceId }),
  },
  conversionGoals: {
    kind: "conversion_goals",
    label: "Conversion goals",
    noun: "conversion goal",
    plural: "conversion goals",
    limit: (p) => p.maxConversionGoals,
    count: (workspaceId) => Goal.countDocuments({ workspaceId }),
  },
};

export async function featureUsage(plan: PlanCatalogEntry, workspaceId: string) {
  const entries = await Promise.all(
    (Object.keys(COUNTED_FEATURES) as CountedFeature[]).map(async (key) => {
      const spec = COUNTED_FEATURES[key];
      return [key, { quota: spec.limit(plan), used: await spec.count(workspaceId) }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<CountedFeature, { quota: number; used: number }>;
}
