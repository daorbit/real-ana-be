import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { User } from "../../modules/identity/models/User.js";
import { asyncHandler } from "./async-handler.js";
import { forbidden } from "../../shared/errors/index.js";

const SECRET = process.env.JWT_SECRET ?? "dev-secret";

export interface AuthedRequest extends Request {
  userId?: string;
  /** Set only on impersonation tokens: the admin acting as `userId`. */
  impersonatorId?: string;
  /** Set on demo tokens: the session is a read-only public demo. */
  isDemo?: boolean;
}

type Payload = { userId: string; impersonatorId?: string; demo?: boolean };

export function signToken(userId: string): string {
  return jwt.sign({ userId }, SECRET, { expiresIn: "7d" });
}

/**
 * A read-only token for the public demo account.
 *
 * Carries a `demo` flag the write guard keys off. Short-lived: a demo session
 * is a look around, not an account, so the token does not need to outlive a
 * browsing session by much.
 */
export function signDemoToken(userId: string): string {
  return jwt.sign({ userId, demo: true }, SECRET, { expiresIn: "12h" });
}

/**
 * A token that acts as `userId` while recording which admin is behind it.
 *
 * Short-lived by design: impersonation is a deliberate, temporary act, and a
 * seven-day window on someone else's account is not something to leave lying
 * around in a browser.
 */
export function signImpersonationToken(userId: string, impersonatorId: string): string {
  return jwt.sign({ userId, impersonatorId }, SECRET, { expiresIn: "1h" });
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no token" });
  try {
    const payload = jwt.verify(token, SECRET) as Payload;
    req.userId = payload.userId;
    req.impersonatorId = payload.impersonatorId;
    req.isDemo = payload.demo === true;
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

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

/**
 * Gate for admin-only routes. Must be mounted after `requireAuth`.
 *
 * Two things are deliberate here. The role is read from the database rather
 * than the token, because tokens live for days and a revoked admin would
 * otherwise keep their powers until theirs expired. And an impersonation token
 * is refused outright — otherwise an admin acting as a user could reach these
 * routes and impersonate onward from there.
 */
export const requireAdmin = asyncHandler<AuthedRequest>(async (req, _res, next) => {
  if (req.impersonatorId) throw forbidden("not available while impersonating");

  const user = await User.findById(req.userId).select("role");
  if (user?.role !== "admin" && user?.role !== "super_admin") throw forbidden("admin only");
  next();
});

/**
 * Gate for superadmin-only routes: granting/revoking admin and deleting
 * users. `super_admin` is a real role on the User document — not derivable
 * from a request body, only settable by a direct DB write — so this can't be
 * spoofed by a client tweaking what it sends. Must be mounted after
 * `requireAuth`.
 */
export const requireSuperAdmin = asyncHandler<AuthedRequest>(async (req, _res, next) => {
  if (req.impersonatorId) throw forbidden("not available while impersonating");

  const user = await User.findById(req.userId).select("role");
  if (user?.role !== "super_admin") throw forbidden("superadmin only");
  next();
});
