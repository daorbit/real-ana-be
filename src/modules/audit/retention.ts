import { currentPlan } from "../billing/quota.service.js";
import { getPlanCatalogEntry } from "../billing/plans.catalog.js";
import { AUDIT_RETENTION_DAYS } from "./models/AuditLog.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function auditWindow(workspaceId: string) {
  const plan = (await currentPlan(workspaceId)) ?? getPlanCatalogEntry("free")!;
  const days = Math.min(plan.auditLogDays, AUDIT_RETENTION_DAYS);
  return {
    days,
    since: new Date(Date.now() - days * DAY_MS),
    plan: plan.name,
    upgradable: plan.auditLogDays < 365,
  };
}
