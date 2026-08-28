import type { Response } from "express";

/**
 * What the client is told about a cap that was hit.
 *
 * The dashboard opens one upgrade dialog for every plan limit in the product,
 * anywhere in the app. It only needs `code` to know that is what happened —
 * this block is what lets the dialog name the cap ("You've reached your Forms
 * limit") and show the counter, instead of a sentence the reader has to parse
 * to work out which of their allowances ran out.
 */
export interface PlanLimitInfo {
  /** Machine name of the cap: `forms`, `sites`, `audits`, `orbit_questions`. */
  kind: string;
  /** Human name for the dialog heading: "Forms", "Scheduled posts". */
  label: string;
  used?: number;
  quota?: number;
  plan?: string;
}

/**
 * The one shape every plan-limit refusal takes, across both services.
 *
 * `quota_exceeded` is an allowance used up; `plan_required` is a feature the
 * plan never included. The client treats both the same way — the reader's next
 * step is the billing page either way — but they are distinct server-side
 * because only one of them is fixed by waiting for the cycle to roll over.
 */
export type PlanLimitCode = "quota_exceeded" | "plan_required";

/**
 * Refuse a request because of the workspace's plan.
 *
 * Always 402, always carrying a code — a bare 402 with a prose `error` reaches
 * the client as a red toast, which is the wrong shape for a decision the reader
 * has to actually make.
 */
export function planLimit(
  res: Response,
  error: string,
  limit?: PlanLimitInfo,
  code: PlanLimitCode = "quota_exceeded",
) {
  return res.status(402).json({ error, code, ...(limit ? { limit } : {}) });
}
