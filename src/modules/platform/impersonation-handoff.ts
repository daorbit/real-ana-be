import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { jwtSecret } from "../../http/middleware/auth.js";
import { claimPlatformToken } from "./replay.service.js";

const KIND = "impersonation_handoff";
const HANDOFF_TTL_SECONDS = 60;

type HandoffClaims = { kind: string; userId: string; by: string; jti: string; exp: number };

export function signImpersonationHandoff(userId: string, by: string): string {
  return jwt.sign({ kind: KIND, userId, by, jti: randomUUID() }, jwtSecret(), { expiresIn: HANDOFF_TTL_SECONDS });
}

export async function redeemImpersonationHandoff(code: string): Promise<{ userId: string; by: string } | null> {
  let claims: HandoffClaims;
  try {
    claims = jwt.verify(code, jwtSecret()) as HandoffClaims;
  } catch {
    return null;
  }
  if (claims.kind !== KIND || !claims.userId || !claims.jti) return null;
  if (!(await claimPlatformToken(`handoff:${claims.jti}`, new Date(claims.exp * 1000)))) return null;
  return { userId: claims.userId, by: claims.by };
}
