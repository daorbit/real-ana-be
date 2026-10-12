import type { Response } from "express";
import bcrypt from "bcryptjs";
import { decryptSecret } from "../../shared/utils/crypto-box.js";
import { verifyTotpCode } from "../../shared/utils/totp.js";
import { User } from "../identity/models/User.js";
import { claimAttempt, clearAttempts } from "./attempt-lock.service.js";

type UserDoc = InstanceType<typeof User>;
type IdentityProof = { password?: unknown; code?: unknown };

export function sendThrottled(res: Response, lockedUntil: Date): void {
  res.status(429).json({
    error: "too many attempts — try again later",
    retryAt: lockedUntil.toISOString(),
  });
}

export function hasOwnershipFactor(user: UserDoc): boolean {
  return Boolean(user.passwordHash || user.totpEnabled || user.pinHash);
}

export async function confirmOwnership(user: UserDoc, body: IdentityProof): Promise<boolean> {
  if (user.passwordHash) return bcrypt.compare(String(body.password ?? ""), user.passwordHash);

  const code = String(body.code ?? "").replace(/\s+/g, "");
  if (user.totpEnabled && user.totpSecretEnc && /^\d{6}$/.test(code)) {
    const secret = decryptSecret(user.totpSecretEnc);
    if (secret && (await verifyTotpCode(code, secret))) return true;
  }
  if (user.pinHash && /^\d{4}$/.test(code)) return bcrypt.compare(code, user.pinHash);
  return false;
}

export async function rejectUnconfirmed(
  user: UserDoc,
  body: IdentityProof,
  res: Response,
): Promise<boolean> {
  const throttleKey = `confirm:${user.id}`;
  const lockedUntil = await claimAttempt(throttleKey);
  if (lockedUntil) {
    sendThrottled(res, lockedUntil);
    return true;
  }

  if (await confirmOwnership(user, body)) {
    await clearAttempts(throttleKey);
    return false;
  }

  res.status(401).json({ error: user.passwordHash ? "incorrect password" : "incorrect PIN or code" });
  return true;
}
