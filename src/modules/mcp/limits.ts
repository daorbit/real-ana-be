import { z } from "zod";

export const TOOL_TIMEOUT_MS = 15_000;
export const CALLS_PER_MINUTE = 60;
export const MAX_RESPONSE_CHARS = 60_000;
export const MAX_PAGE = 100;
export const MAX_PAGE_SIZE = 25;
export const MAX_TEXT = 500;
export const MAX_ANSWERS = 60;
export const MAX_FIELDS = 150;
export const MAX_OPTIONS = 30;
export const TOP_N = 10;

export const pageArg = z.number().int().min(1).max(MAX_PAGE).default(1).describe("1-based page number");
export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(10)
  .describe(`Items per page, at most ${MAX_PAGE_SIZE}`);
export const formIdArg = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, "formId must be the 24-character id returned by list_forms")
  .describe("Form id from list_forms");
export const isoDateArg = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date, e.g. 2026-10-01")
  .describe("ISO 8601 date or date-time");
export const rangeDaysArg = z.enum(["7d", "30d", "90d", "365d"]).default("30d").describe("Look-back window");

export function rangeToDays(range: "7d" | "30d" | "90d" | "365d"): number {
  return Number(range.replace("d", ""));
}

export function clip(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function paging(page: number, limit: number, total: number) {
  return { page, limit, total, hasMore: page * limit < total };
}
