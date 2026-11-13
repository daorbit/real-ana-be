export const STATUS_COMPONENTS = [
  { id: "dashboard", name: "Dashboard", description: "The Quantalog web app where you sign in and see your data." },
  { id: "api", name: "API", description: "The service behind the dashboard, the public API and the MCP connector." },
  { id: "tracking", name: "Tracking", description: "The tracking script and the endpoints that receive visits and events." },
  { id: "forms", name: "Lead capture", description: "Forms, form responses, bookings and payments." },
  { id: "invoicing", name: "Invoicing", description: "Quotations, invoices and public payment links." },
  { id: "jobs", name: "Scheduled jobs", description: "Reports, alerts, scheduled posts, campaigns and other timed work." },
] as const;

export type StatusComponentId = (typeof STATUS_COMPONENTS)[number]["id"];

export const STATUS_COMPONENT_IDS = STATUS_COMPONENTS.map((c) => c.id) as StatusComponentId[];

export type ComponentState = "operational" | "degraded" | "outage" | "maintenance";

export const STATE_RANK: Record<ComponentState, number> = { operational: 0, maintenance: 1, degraded: 2, outage: 3 };

export function worst(states: ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((acc, s) => (STATE_RANK[s] > STATE_RANK[acc] ? s : acc), "operational");
}

export function isStatusComponent(value: unknown): value is StatusComponentId {
  return typeof value === "string" && (STATUS_COMPONENT_IDS as string[]).includes(value);
}

export const INCIDENT_IMPACTS = ["minor", "major", "maintenance"] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

export const IMPACT_STATE: Record<IncidentImpact, ComponentState> = {
  minor: "degraded",
  major: "outage",
  maintenance: "maintenance",
};

export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved", "scheduled", "in_progress", "completed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CLOSED_STATUSES: IncidentStatus[] = ["resolved", "completed"];

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
};
