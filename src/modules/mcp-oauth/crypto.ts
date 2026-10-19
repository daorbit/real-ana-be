import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = {
  access: "qlm_at_",
  refresh: "qlm_rt_",
  code: "qlm_ac_",
  client: "qlm_client_",
  request: "qlm_rq_",
} as const;

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isValidChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_PATTERN.test(challenge);
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
