import { Session } from "./models/Session.js";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export function sessionCutoff(now = Date.now()): Date {
  return new Date(now - SESSION_TTL_MS);
}

export async function liveSessionJtis(jtis: string[]): Promise<Set<string>> {
  if (!jtis.length) return new Set();
  const rows = await Session.find({ jti: { $in: jtis }, revokedAt: null, createdAt: { $gt: sessionCutoff() } })
    .select("jti")
    .lean();
  return new Set(rows.map((row) => String(row.jti)));
}
