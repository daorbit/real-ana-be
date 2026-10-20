import type { Response } from "express";
import { canCreateSite } from "../modules/billing/quota.service.js";
import { planLimit } from "./plan-limit.js";

export async function guardSiteCreation(res: Response, workspaceId: string): Promise<boolean> {
  const allowed = await canCreateSite(workspaceId);
  if (allowed.ok) return true;
  if (allowed.limit?.kind === "sites") res.status(409).json({ error: allowed.error, code: "site_limit" });
  else planLimit(res, allowed.error, allowed.limit);
  return false;
}
