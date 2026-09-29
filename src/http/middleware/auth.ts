import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { User } from "../../modules/identity/models/User.js";
import { Session } from "../../modules/identity/models/Session.js";
import { sessionInfoFor } from "../../shared/utils/session-info.js";
import { asyncHandler } from "./async-handler.js";
import { forbidden } from "../../shared/errors/index.js";

 
export function jwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (value) return value;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET is not set. Refusing to sign or verify tokens with a default key.",
    );
  }
  return "dev-secret";
}

export interface AuthedRequest extends Request {
  userId?: string;
  impersonatorId?: string;
  isDemo?: boolean;
  sessionJti?: string;
}

type Payload = { userId: string; impersonatorId?: string; demo?: boolean; jti?: string };
type Pending2faPayload = { userId: string; pending2fa: true };

export function signToken(userId: string, req?: Request): string {
  if (!req) return jwt.sign({ userId }, jwtSecret(), { expiresIn: "7d" });

  const jti = randomUUID();
  const info = sessionInfoFor(req);
  void Session.create({ userId, jti, ...info }).catch((e: unknown) => {
    console.error("[auth] could not record session:", e instanceof Error ? e.message : e);
  });

  return jwt.sign({ userId, jti }, jwtSecret(), { expiresIn: "7d" });
}

export function signPending2faToken(userId: string): string {
  return jwt.sign({ userId, pending2fa: true }, jwtSecret(), { expiresIn: "10m" });
}

export function verifyPending2faToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, jwtSecret()) as Pending2faPayload;
    return payload.pending2fa === true ? payload.userId : null;
  } catch {
    return null;
  }
}

 
export function signDemoToken(userId: string): string {
  return jwt.sign({ userId, demo: true }, jwtSecret(), { expiresIn: "12h" });
}

 
export function signImpersonationToken(userId: string, impersonatorId: string): string {
  return jwt.sign({ userId, impersonatorId }, jwtSecret(), { expiresIn: "1h" });
}

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export const requireAuth = asyncHandler<AuthedRequest>(async (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no token" });

  let payload: Payload;
  try {
    payload = jwt.verify(token, jwtSecret()) as Payload;
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }

  if (payload.jti) {
    const session = await Session.findOne({ jti: payload.jti }).select("revokedAt lastSeenAt");
    if (!session || session.revokedAt) return res.status(401).json({ error: "session revoked" });

    if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      void Session.updateOne({ _id: session._id }, { lastSeenAt: new Date() }).catch(() => {});
    }
  }

  req.userId = payload.userId;
  req.impersonatorId = payload.impersonatorId;
  req.isDemo = payload.demo === true;
  req.sessionJti = payload.jti;
  next();
});

export const requireUnlocked = asyncHandler<AuthedRequest & { apiKeyId?: string }>(async (req, res, next) => {
  if (req.isDemo) return next();

  if (req.apiKeyId) return next();
  const user = await User.findById(req.userId).select("lockedAt");
  if (user?.lockedAt) return res.status(423).json({ error: "screen is locked", locked: true });
  next();
});

const DEMO_COMPUTE_ALLOW = [/\/funnel$/];

export function blockDemoWrites(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const readOnly = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  const computeOnly = DEMO_COMPUTE_ALLOW.some((re) => re.test(req.path));
  if (req.isDemo && !readOnly && !computeOnly) {
    return res.status(403).json({ error: "demo mode is read-only", demo: true });
  }
  next();
}

 
export const requireAdmin = asyncHandler<AuthedRequest>(async (req, _res, next) => {
  if (req.impersonatorId) throw forbidden("not available while impersonating");

  const user = await User.findById(req.userId).select("role");
  if (user?.role !== "admin" && user?.role !== "super_admin") throw forbidden("admin only");
  next();
});

 
export const requireSuperAdmin = asyncHandler<AuthedRequest>(async (req, _res, next) => {
  if (req.impersonatorId) throw forbidden("not available while impersonating");

  const user = await User.findById(req.userId).select("role");
  if (user?.role !== "super_admin") throw forbidden("superadmin only");
  next();
});
