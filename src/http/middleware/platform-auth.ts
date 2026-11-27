import type { Request } from "express";
import { asyncHandler } from "./async-handler.js";
import { readPlatformToken, type PlatformAdmin } from "../../modules/platform/platform-token.js";
import { claimPlatformToken } from "../../modules/platform/replay.service.js";

export interface PlatformRequest extends Request {
  platformAdmin?: PlatformAdmin;
}

const STATUS = { missing: 401, invalid: 401, expired: 401, not_configured: 503 } as const;

function bearer(req: Request): string | null {
  const header = req.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

export function requirePlatform(...scopes: string[]) {
  return asyncHandler<PlatformRequest>(async (req, res, next) => {
    const result = readPlatformToken(bearer(req));
    if (!result.ok) return res.status(STATUS[result.reason]).json({ error: `platform_${result.reason}` });
    if (!scopes.every((scope) => result.admin.scopes.includes(scope))) {
      return res.status(403).json({ error: "platform_forbidden" });
    }
    if (!(await claimPlatformToken(result.admin.jti, result.admin.expiresAt))) {
      return res.status(401).json({ error: "platform_replayed" });
    }
    req.platformAdmin = result.admin;
    res.setHeader("Cache-Control", "no-store");
    next();
  });
}
