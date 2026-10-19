import { createHmac } from "node:crypto";

export function formsServiceSecret(): string | null {
  return process.env.FORMS_SERVICE_SECRET || null;
}

export function signFormsWorkspaceToken(
  secret: string,
  workspaceId: string,
  actorId: string,
  ttlSeconds: number,
): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${workspaceId}.${expiresAt}.${actorId}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt };
}
