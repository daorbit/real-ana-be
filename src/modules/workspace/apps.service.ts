import { Workspace } from "./models/Workspace.js";
import { paidAppUnlocked } from "../billing/paid-apps.catalog.js";

export const WORKSPACE_APPS = [
  "compare",
  "goals",
  "notes",
  "reviews",
  "links",
  "media",
  "alerts",
  "popups",
  "publicDashboard",
  "seoReports",
  "bio",
] as const;
export type WorkspaceApp = (typeof WORKSPACE_APPS)[number];

export const APP_DISABLED_MESSAGE: Record<WorkspaceApp, string> = {
  compare: "Quantalog Compare is off for this workspace. Turn it on in Apps.",
  goals: "Quantalog Goals is off for this workspace. Turn it on in Apps.",
  notes: "Quantalog Notes is off for this workspace. Turn it on in Apps.",
  reviews: "Quantalog Reviews is off for this workspace. Turn it on in Apps.",
  links: "Quantalog Links is off for this workspace. Turn it on in Apps.",
  media: "Quantalog Media is off for this workspace. Turn it on in Apps.",
  alerts: "Quantalog Alerts is off for this workspace. Turn it on in Apps.",
  popups: "Quantalog Popups is off for this workspace. Turn it on in Apps.",
  publicDashboard: "Quantalog Public Dashboard is off for this workspace. Turn it on in Apps.",
  seoReports: "Quantalog SEO Reports is off for this workspace. Turn it on in Apps.",
  bio: "Quantalog Link-in-bio is off for this workspace. Turn it on in Apps.",
};

export function appEnabledFilter(app: WorkspaceApp): Record<string, true> {
  return { [`apps.${app}.enabled`]: true };
}

type AppsCarrier = { get: (path: string) => unknown };

export function isWorkspaceApp(value: unknown): value is WorkspaceApp {
  return typeof value === "string" && (WORKSPACE_APPS as readonly string[]).includes(value);
}

export function appEnabled(workspace: AppsCarrier, app: WorkspaceApp): boolean {
  return workspace.get(`apps.${app}.enabled`) === true && paidAppUnlocked(workspace, app);
}

export async function setAppEnabled(workspaceId: string, app: WorkspaceApp, enabled: boolean) {
  const updated = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $set: { [`apps.${app}.enabled`]: enabled, ...(enabled ? { [`apps.${app}.enabledAt`]: new Date() } : {}) } },
    { new: true },
  ).select("apps");
  return updated?.get("apps") ?? null;
}
