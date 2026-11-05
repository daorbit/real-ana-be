import jwt from "jsonwebtoken";
import { jwtSecret } from "../../http/middleware/auth.js";

const KIND = "campaign-unsubscribe";

export interface UnsubscribeClaims {
  workspaceId: string;
  campaignId: string;
  email: string;
}

function apiOrigin(): string {
  return (process.env.API_URL || process.env.PUBLIC_BASE_URL || "https://quantalog-be.daorbit.in").replace(/\/+$/, "");
}

export function unsubscribeUrl(claims: UnsubscribeClaims): string {
  const token = jwt.sign({ kind: KIND, w: claims.workspaceId, c: claims.campaignId, e: claims.email }, jwtSecret());
  return `${apiOrigin()}/api/public/campaigns/unsubscribe?t=${encodeURIComponent(token)}`;
}

export function readUnsubscribeToken(token: unknown): UnsubscribeClaims | null {
  if (typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, jwtSecret()) as { kind?: string; w?: string; c?: string; e?: string };
    if (payload.kind !== KIND || !payload.w || !payload.c || !payload.e) return null;
    return { workspaceId: payload.w, campaignId: payload.c, email: payload.e };
  } catch {
    return null;
  }
}
