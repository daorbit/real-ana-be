import type { WorkspaceApp } from "../workspace/apps.service.js";

export const PAID_APPS = [
  "notes",
  "reviews",
  "alerts",
  "links",
  "bio",
  "popups",
  "funnels",
  "publicDashboard",
  "insights",
  "tasks",
  "invoicing",
] as const satisfies readonly WorkspaceApp[];
export type PaidApp = (typeof PAID_APPS)[number];

export const DEFAULT_APP_PRICE_INR = 59900;

export const PAID_APP_NAMES: Record<PaidApp, string> = {
  notes: "Quantalog Notes",
  reviews: "Quantalog Reviews",
  alerts: "Quantalog Alerts",
  links: "Quantalog Links",
  bio: "Quantalog Link-in-bio",
  popups: "Quantalog Popups",
  funnels: "Quantalog Funnels",
  publicDashboard: "Quantalog Public Dashboard",
  insights: "Quantalog Insights",
  tasks: "Quantalog Tasks",
  invoicing: "Quantalog Invoicing",
};

export const PAYMENT_ONLY_APPS: readonly PaidApp[] = [
  "notes",
  "popups",
  "publicDashboard",
  "insights",
  "tasks",
  "invoicing",
];

type AppsCarrier = { get: (path: string) => unknown };

export function isPaidApp(value: unknown): value is PaidApp {
  return typeof value === "string" && (PAID_APPS as readonly string[]).includes(value);
}

export function paidAppUnlocked(workspace: AppsCarrier, app: string): boolean {
  if (!isPaidApp(app)) return true;
  if (workspace.get(`apps.${app}.paidAt`)) return true;
  return !PAYMENT_ONLY_APPS.includes(app) && Boolean(workspace.get(`apps.${app}.enabledAt`));
}
