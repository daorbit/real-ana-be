import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { User } from "./models/User.js";

const SECRET = process.env.JWT_SECRET ?? "dev-secret";

export interface AuthedRequest extends Request {
  userId?: string;
}

export function signToken(userId: string): string {
  return jwt.sign({ userId }, SECRET, { expiresIn: "7d" });
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
    const payload = jwt.verify(token, SECRET) as { userId: string };
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

/**
 * Gate for admin-only routes. Must be mounted after `requireAuth`.
 *
 * The role is read from the database rather than the token on purpose: tokens
 * live for seven days, so a revoked admin would otherwise keep their powers
 * until theirs happened to expire.
 */
export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const user = await User.findById(req.userId).select("role");
  if (user?.role !== "admin")
    return res.status(403).json({ error: "admin only" });
  next();
}
