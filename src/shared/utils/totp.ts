import { TOTP } from "otplib";
import { NodeCryptoPlugin } from "@otplib/plugin-crypto-node";
import { ScureBase32Plugin } from "@otplib/plugin-base32-scure";

/**
 * One configured instance for the whole app: every account uses the same
 * algorithm, digit count and period, so there is nothing per-user to carry
 * around beyond the secret itself.
 */
const totp = new TOTP({
  issuer: "Quantalog",
  crypto: new NodeCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

export function generateTotpSecret(): string {
  return totp.generateSecret();
}

export function totpKeyUri(email: string, secret: string): string {
  return totp.toURI({ label: email, secret });
}

export async function verifyTotpCode(code: string, secret: string): Promise<boolean> {
  // ±1 period of drift: generous enough for a phone clock that's a little
  // off, narrow enough that it's still one code, not a minute of them.
  const result = await totp.verify(code, { secret, epochTolerance: 30 });
  return result.valid;
}
