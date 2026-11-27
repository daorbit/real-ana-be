import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const PLATFORM_ISSUER = "da-super-admin";
export const PLATFORM_AUDIENCE = "quantalog";

const MAX_LIFETIME_SECONDS = 90;
const CLOCK_TOLERANCE_SECONDS = 30;

export type PlatformAdmin = {
  id: string;
  email: string;
  scopes: string[];
  jti: string;
  expiresAt: Date;
  reason: string;
};

export type PlatformTokenResult =
  | { ok: true; admin: PlatformAdmin }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "not_configured" };

let keyCache: { source: string; keys: Map<string, KeyObject> } | null = null;

function toPem(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("-----BEGIN") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
}

function publicKeys(): Map<string, KeyObject> {
  const source = process.env.PLATFORM_PUBLIC_KEYS ?? "";
  if (keyCache?.source === source) return keyCache.keys;
  const keys = new Map<string, KeyObject>();
  if (source) {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    for (const [kid, pem] of Object.entries(parsed)) {
      if (typeof pem === "string") keys.set(kid, createPublicKey(toPem(pem)));
    }
  }
  keyCache = { source, keys };
  return keys;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function audienceMatches(aud: unknown): boolean {
  return aud === PLATFORM_AUDIENCE || (Array.isArray(aud) && aud.includes(PLATFORM_AUDIENCE));
}

export function readPlatformToken(token: string | null): PlatformTokenResult {
  if (!token) return { ok: false, reason: "missing" };
  const keys = publicKeys();
  if (!keys.size) return { ok: false, reason: "not_configured" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const header = decodeJson(rawHeader);
  const key = typeof header?.kid === "string" ? keys.get(header.kid) : undefined;
  if (!header || header.alg !== "ES256" || !key) return { ok: false, reason: "invalid" };

  const signed = verify(
    "sha256",
    Buffer.from(`${rawHeader}.${rawPayload}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(rawSignature, "base64url"),
  );
  if (!signed) return { ok: false, reason: "invalid" };

  const payload = decodeJson(rawPayload);
  if (!payload) return { ok: false, reason: "invalid" };
  const { iss, aud, sub, email, scopes, jti, iat, exp, reason } = payload;
  if (iss !== PLATFORM_ISSUER || !audienceMatches(aud)) return { ok: false, reason: "invalid" };
  if (typeof sub !== "string" || typeof jti !== "string" || typeof iat !== "number" || typeof exp !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return { ok: false, reason: "invalid" };

  const now = Math.floor(Date.now() / 1000);
  if (exp - iat > MAX_LIFETIME_SECONDS || iat > now + CLOCK_TOLERANCE_SECONDS) return { ok: false, reason: "invalid" };
  if (exp + CLOCK_TOLERANCE_SECONDS < now) return { ok: false, reason: "expired" };

  return {
    ok: true,
    admin: {
      id: sub,
      email: typeof email === "string" ? email : "",
      scopes: scopes as string[],
      jti,
      expiresAt: new Date((exp + CLOCK_TOLERANCE_SECONDS) * 1000),
      reason: typeof reason === "string" ? reason : "",
    },
  };
}
