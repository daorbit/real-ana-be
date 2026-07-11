import crypto from "crypto";
import { Response, NextFunction, Request } from "express";
import { nanoid } from "nanoid";
import { ApiKey } from "./models/ApiKey.js";

export interface ApiKeyRequest extends Request {
  workspaceId?: string;
  apiKeyId?: string;
}

// Generate a new raw key + its stored hash/prefix. Raw is shown to user once.
export function generateKey() {
  const raw = `sk_live_${nanoid(32)}`;
  const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12); // sk_live_ab12
  return { raw, keyHash, prefix };
}

export function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Middleware: authenticate a platform API call via Bearer sk_live_...
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
  const keyHash = hashKey(raw);
  const key = await ApiKey.findOne({ keyHash, revoked: false });
  if (!key) return res.status(401).json({ error: "invalid API key" });

  req.workspaceId = String(key.workspaceId);
  req.apiKeyId = key.id;
  // fire-and-forget last-used update
  ApiKey.updateOne({ _id: key._id }, { lastUsedAt: new Date() }).catch(() => {});
  next();
}
