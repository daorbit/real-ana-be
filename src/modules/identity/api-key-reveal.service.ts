import { decryptSecret } from "../../shared/utils/crypto-box.js";
import { ApiKey } from "./models/ApiKey.js";
import { User } from "./models/User.js";

export type RevealTarget =
  | { ok: true; key: InstanceType<typeof ApiKey>; user: InstanceType<typeof User> }
  | { ok: false; status: number; error: string };

export async function loadRevealTarget(
  workspaceId: string,
  keyId: string,
  userId: string,
): Promise<RevealTarget> {
  const [key, user] = await Promise.all([
    ApiKey.findOne({ _id: keyId, workspaceId, revoked: false }).select("+keyEnc name prefix"),
    User.findById(userId).select("passwordHash pinHash totpEnabled totpSecretEnc"),
  ]);
  if (!key) return { ok: false, status: 404, error: "key not found" };
  if (!user) return { ok: false, status: 404, error: "not found" };
  if (!key.get("keyEnc")) {
    return {
      ok: false,
      status: 409,
      error: "this key was created before keys could be revealed — create a new key instead",
    };
  }
  return { ok: true, key, user };
}

export function decryptApiKey(key: InstanceType<typeof ApiKey>): string | null {
  return decryptSecret(String(key.get("keyEnc") ?? ""));
}
