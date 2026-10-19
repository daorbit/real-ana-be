import type { NextFunction, Request, Response } from "express";
import { mcpEnabled } from "../../modules/mcp-oauth/config.js";
import { overRateLimit } from "../../modules/security/rate-limit.service.js";
import { hashIp } from "../../shared/utils/ip-hash.js";

export function requireMcpEnabled(_req: Request, res: Response, next: NextFunction) {
  if (!mcpEnabled()) return res.status(404).json({ error: "not found" });
  next();
}

export function limitByIp(bucket: string, limit: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await overRateLimit(`${bucket}:${hashIp(req.ip ?? "")}`, limit, windowMs)) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "slow_down", error_description: "too many requests — try again shortly" });
    }
    next();
  };
}
