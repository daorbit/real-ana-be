import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { User } from "./models/User.js";

const SECRET = process.env.JWT_SECRET ?? "dev-secret";

export interface AuthedRequest extends Request {
  userId?: string;
  /** Set only on impersonation tokens: the admin acting as `userId`. */
  impersonatorId?: string;
}

type Payload = { userId: string; impersonatorId?: string };

export function signToken(userId: string): string {
  return jwt.sign({ userId }, SECRET, { expiresIn: "7d" });
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
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
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
export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  if (req.impersonatorId)
    return res.status(403).json({ error: "not available while impersonating" });

  const user = await User.findById(req.userId).select("role");
  if (user?.role !== "admin")
    return res.status(403).json({ error: "admin only" });
  next();
}
