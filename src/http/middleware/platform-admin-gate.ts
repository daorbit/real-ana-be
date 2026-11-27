import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { requirePlatform, type PlatformRequest } from "./platform-auth.js";

export const PLATFORM_ADMIN_BASE = "/api/platform/v1/admin";

type Rule = { methods: string[]; path: RegExp; scope: string };

const RULES: Rule[] = [
  { methods: ["GET"], path: /^\/users$/, scope: "users:read" },
  { methods: ["GET"], path: /^\/users\/[^/]+\/(overview|billing)$/, scope: "users:read" },
  { methods: ["GET"], path: /^\/email\/(status|templates|segments|recipients)$/, scope: "users:read" },
  { methods: ["POST"], path: /^\/email\/preview$/, scope: "users:read" },
  { methods: ["POST"], path: /^\/email\/(send|test)$/, scope: "users:email" },
  { methods: ["GET"], path: /^\/billing\/(plans|fx|addons|coupons)$/, scope: "plans:read" },
  { methods: ["PUT"], path: /^\/billing\/plans\/[^/]+$/, scope: "plans:edit" },
  { methods: ["POST"], path: /^\/billing\/plans\/sync-currency$/, scope: "plans:publish" },
  { methods: ["POST"], path: /^\/billing\/addons$/, scope: "plans:edit" },
  { methods: ["PUT", "DELETE"], path: /^\/billing\/addons\/[^/]+$/, scope: "plans:edit" },
  { methods: ["POST"], path: /^\/billing\/coupons$/, scope: "promotions:edit" },
  { methods: ["PUT", "DELETE"], path: /^\/billing\/coupons\/[^/]+$/, scope: "promotions:edit" },
  { methods: ["GET"], path: /^\/referrals(\/(settings|overview|top))?$/, scope: "plans:read" },
  { methods: ["PUT"], path: /^\/referrals\/settings$/, scope: "promotions:edit" },
  { methods: ["POST"], path: /^\/referrals\/[^/]+\/(reward|reject|revoke)$/, scope: "promotions:edit" },
  { methods: ["PUT"], path: /^\/referrals\/codes\/[^/]+$/, scope: "promotions:edit" },
  { methods: ["GET"], path: /^\/demo\/usage$/, scope: "config:read" },
  { methods: ["PUT"], path: /^\/demo\/limit$/, scope: "config:edit" },
  { methods: ["GET"], path: /^\/ops-alerts$/, scope: "config:read" },
  { methods: ["PUT"], path: /^\/ops-alerts$/, scope: "config:edit" },
  { methods: ["POST"], path: /^\/ops-alerts\/test$/, scope: "config:edit" },
  { methods: ["GET"], path: /^\/db\/(stats|connections)$/, scope: "config:read" },
  { methods: ["GET"], path: /^\/db\/connections\/[^/]+\/stats$/, scope: "config:read" },
  { methods: ["POST"], path: /^\/db\/connections$/, scope: "config:edit" },
  { methods: ["DELETE"], path: /^\/db\/connections\/[^/]+$/, scope: "config:edit" },
  { methods: ["GET"], path: /^\/workers-ai\/trend$/, scope: "config:read" },
  { methods: ["GET"], path: /^\/status$/, scope: "config:read" },
  { methods: ["POST"], path: /^\/status\/incidents$/, scope: "config:edit" },
  { methods: ["POST"], path: /^\/status\/incidents\/[^/]+\/updates$/, scope: "config:edit" },
  { methods: ["PATCH", "DELETE"], path: /^\/status\/incidents\/[^/]+$/, scope: "config:edit" },
];

function relativePath(req: AuthedRequest): string {
  const full = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  return full.slice(PLATFORM_ADMIN_BASE.length) || "/";
}

export function platformAdminGate(req: AuthedRequest, res: Response, next: NextFunction) {
  const path = relativePath(req);
  const rule = RULES.find((entry) => entry.methods.includes(req.method) && entry.path.test(path));
  if (!rule) return res.status(404).json({ error: "not available to the platform console" });

  const check = requirePlatform(rule.scope);
  check(req as PlatformRequest, res, (error?: unknown) => {
    if (error) return next(error);
    const admin = (req as PlatformRequest).platformAdmin;
    if (!admin) return res.status(401).json({ error: "platform_missing" });
    req.platformActor = { id: admin.id, email: admin.email };
    next();
  });
}
