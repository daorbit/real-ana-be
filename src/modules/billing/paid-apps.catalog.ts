import type { WorkspaceApp } from "../workspace/apps.service.js";

export const PAID_APPS = ["notes", "reviews", "alerts", "links", "bio", "popups"] as const satisfies readonly WorkspaceApp[];
export type PaidApp = (typeof PAID_APPS)[number];

export const DEFAULT_APP_PRICE_INR = 59900;

export const PAID_APP_NAMES: Record<PaidApp, string> = {
  notes: "Quantalog Notes",
  reviews: "Quantalog Reviews",
  alerts: "Quantalog Alerts",
  links: "Quantalog Links",
  bio: "Quantalog Link-in-bio",
  popups: "Quantalog Popups",
};

export function isPaidApp(value: unknown): value is PaidApp {
  return typeof value === "string" && (PAID_APPS as readonly string[]).includes(value);
}
