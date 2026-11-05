import type { Request } from "express";
import { createBurstLimiter } from "../../shared/utils/burst-limit.js";
import { clientIp } from "./enrich.js";

const MAX_REQUESTS_PER_MINUTE = 240;

const overLimit = createBurstLimiter(MAX_REQUESTS_PER_MINUTE, 60_000);

export function overIngestBurst(req: Request, siteId: unknown): boolean {
  return overLimit(`${clientIp(req)}:${String(siteId)}`);
}
