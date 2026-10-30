import { scheduleAlertChecks } from "../alerts/alerts.service.js";
import { syncPublicDashboard } from "../analytics/public-dashboard.service.js";
import { scheduleInsights } from "../insights/insights.service.js";
import { Task } from "../tasks/models/Task.js";
import type { WorkspaceApp } from "./apps.service.js";

const HOOKS: Partial<Record<WorkspaceApp, (workspaceId: string, enabled: boolean) => Promise<void>>> = {
  alerts: scheduleAlertChecks,
  publicDashboard: syncPublicDashboard,
  insights: scheduleInsights,
  tasks: async (workspaceId, enabled) => {
    if (!enabled) await Task.deleteMany({ workspaceId });
  },
};

export async function onAppToggled(workspaceId: string, app: WorkspaceApp, enabled: boolean): Promise<void> {
  await HOOKS[app]?.(workspaceId, enabled);
}
