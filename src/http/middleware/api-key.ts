import crypto from "crypto";
import { Response, NextFunction, Request } from "express";
import { nanoid } from "nanoid";
import { ApiKey } from "../../modules/identity/models/ApiKey.js";

export interface ApiKeyRequest extends Request {
  workspaceId?: string;
  apiKeyId?: string;
}

export const KEY_EXPIRY_DAYS = [7, 30, 60, 90, 180, 365] as const;

export function generateKey() {
  const raw = `sk_live_${nanoid(32)}`;
  const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12); // sk_live_ab12
  return { raw, keyHash, prefix };
}

export function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function expiryFromDays(days: unknown): Date | null | undefined {
  if (days === null || days === undefined || days === "never") return null;
  const n = Number(days);
  if (!(KEY_EXPIRY_DAYS as readonly number[]).includes(n)) return undefined;
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

type KeyLookup =
  | { ok: true; key: InstanceType<typeof ApiKey> }
  | { ok: false; error: string };

export async function findActiveKey(raw: string): Promise<KeyLookup> {
  const key = await ApiKey.findOne({ keyHash: hashKey(raw), revoked: false });
  if (!key) return { ok: false, error: "invalid API key" };
  const expiresAt = key.get("expiresAt") as Date | null | undefined;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "API key has expired" };
  }
  ApiKey.updateOne({ _id: key._id }, { lastUsedAt: new Date() }).catch(() => {});
  return { ok: true, key };
}

export async function requireApiKey(
  req: ApiKeyRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!raw || !raw.startsWith("sk_")) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  const found = await findActiveKey(raw);
  if (!found.ok) return res.status(401).json({ error: found.error });

  req.workspaceId = String(found.key.workspaceId);
  req.apiKeyId = found.key.id;
  next();
}
