import type { Response } from "express";


export interface PlanLimitInfo {
  kind: string;
  label: string;
  used?: number;
  quota?: number;
  plan?: string;
}


export type PlanLimitCode = "quota_exceeded" | "plan_required";

export function planLimit(
  res: Response,
  error: string,
  limit?: PlanLimitInfo,
  code: PlanLimitCode = "quota_exceeded",
) {
  return res.status(402).json({ error, code, ...(limit ? { limit } : {}) });
}
