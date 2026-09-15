import type { Response } from "express";


export interface PlanLimitInfo {
  kind: string;
  /** The cap's name, for a dialog heading. Omitted by a `plan_required`
   * refusal: nothing was used up, so there is no limit to name. */
  label?: string;
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
