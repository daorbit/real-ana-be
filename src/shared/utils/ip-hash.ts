import crypto from "crypto";

export function hashIp(ip: string): string {
  const secret = process.env.JWT_SECRET ?? "";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}
