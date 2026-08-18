import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Symmetric encryption for third-party credentials at rest.
 *
 * The problem this solves is narrow: OAuth access tokens are bearer
 * credentials for someone else's account, and a database dump that hands the
 * reader a working LinkedIn token is a different class of incident from one
 * that hands them a bcrypt hash. Everything else the app stores is either
 * public, hashed, or ours to revoke.
 *
 * AES-256-GCM rather than CBC: the tag makes the ciphertext tamper-evident, so
 * a modified row fails to decrypt instead of decrypting to something else. The
 * nonce is fresh per encryption and stored alongside, which is what keeps two
 * encryptions of the same token from looking alike.
 */

const ALGORITHM = "aes-256-gcm";
/** GCM's standard nonce width. Longer nonces are rehashed internally and gain nothing. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Marks the format so a future scheme can be told apart from this one on read. */
const VERSION = "v1";

/**
 * The 32-byte key, derived from configuration.
 *
 * `TOKEN_ENCRYPTION_KEY` is the intended source. It falls back to `JWT_SECRET`
 * so that an existing deployment keeps working without a new variable being set
 * first — losing the key means losing every stored token, and a connection that
 * silently stops decrypting after a deploy is worse than one that reuses a
 * secret already treated as sensitive. Both are run through SHA-256 so any
 * length of input yields a valid key.
 *
 * Read per call rather than at module load: `dotenv` may not have populated the
 * environment yet at import time, and caching an empty key would outlive the
 * fix.
 */
function key(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || "";
  if (!secret) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY (or JWT_SECRET) must be set to store third-party tokens",
    );
  }
  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a string for storage.
 *
 * Returns `v1:<iv>:<tag>:<ciphertext>`, all base64url. One self-describing
 * column rather than three, so a token can never be half-written.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a value produced by `encryptSecret`.
 *
 * Returns `null` for anything that does not decrypt cleanly — wrong key,
 * truncated column, tampered ciphertext, or a value written before encryption
 * existed. Callers treat that as "no usable token", which is the same recovery
 * path as an expired one, so there is nothing useful to distinguish here and
 * throwing would only turn a re-connect prompt into a 500.
 */
export function decryptSecret(payload: string): string | null {
  try {
    const parts = payload.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;

    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const data = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison, for values where a mismatch is a security
 * outcome rather than a lookup miss.
 *
 * Both sides are hashed first so the comparison runs over equal-length buffers:
 * `timingSafeEqual` throws on a length mismatch, and that throw would itself
 * leak the length it was meant to hide.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
