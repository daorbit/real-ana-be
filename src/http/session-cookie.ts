import type { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "qa_session";
export const ADMIN_SESSION_COOKIE = "qa_admin_session";

export type SessionHint = { id: string; demo: boolean; impersonating: boolean };

type TokenClaims = { exp?: number; jti?: string; demo?: boolean; impersonatorId?: string };

const baseOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
};

function claimsOf(token: string): TokenClaims {
  return (jwt.decode(token) as TokenClaims | null) ?? {};
}

function optionsFor(token: string): CookieOptions {
  const { exp } = claimsOf(token);
  return exp ? { ...baseOptions, expires: new Date(exp * 1000) } : baseOptions;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

export function sessionTokenFrom(req: Request): { token: string; viaCookie: boolean } | null {
  const bearer = bearerToken(req);
  if (bearer) return { token: bearer, viaCookie: false };
  const cookie = readCookie(req, SESSION_COOKIE);
  return cookie ? { token: cookie, viaCookie: true } : null;
}

export function cookieSessionToken(req: Request): string {
  return readCookie(req, SESSION_COOKIE) ?? "";
}

export function sessionHint(token: string): SessionHint {
  const claims = claimsOf(token);
  return { id: claims.jti ?? "", demo: claims.demo === true, impersonating: Boolean(claims.impersonatorId) };
}

export function startSession(res: Response, token: string): { session: SessionHint } {
  res.cookie(SESSION_COOKIE, token, optionsFor(token));
  return { session: sessionHint(token) };
}

export function stashAdminSession(res: Response, token: string): void {
  res.cookie(ADMIN_SESSION_COOKIE, token, optionsFor(token));
}

export function clearAdminSession(res: Response): void {
  res.clearCookie(ADMIN_SESSION_COOKIE, baseOptions);
}

export function endSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, baseOptions);
  clearAdminSession(res);
}
