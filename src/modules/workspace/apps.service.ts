import { Workspace } from "./models/Workspace.js";

export const WORKSPACE_APPS = ["compare", "goals", "notes"] as const;
export type WorkspaceApp = (typeof WORKSPACE_APPS)[number];

export const APP_DISABLED_MESSAGE: Record<WorkspaceApp, string> = {
  compare: "Quantalog Compare is off for this workspace. Turn it on in Settings → Connections.",
  goals: "Quantalog Goals is off for this workspace. Turn it on in Settings → Connections.",
  notes: "Quantalog Notes is off for this workspace. Turn it on in Settings → Connections.",
};

type AppsCarrier = { get: (path: string) => unknown };

export function isWorkspaceApp(value: unknown): value is WorkspaceApp {
  return typeof value === "string" && (WORKSPACE_APPS as readonly string[]).includes(value);
}

export function appEnabled(workspace: AppsCarrier, app: WorkspaceApp): boolean {
  return workspace.get(`apps.${app}.enabled`) === true;
}

export async function setAppEnabled(workspaceId: string, app: WorkspaceApp, enabled: boolean) {
  const updated = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $set: { [`apps.${app}.enabled`]: enabled, ...(enabled ? { [`apps.${app}.enabledAt`]: new Date() } : {}) } },
    { new: true },
  ).select("apps");
  return updated?.get("apps") ?? null;
}
