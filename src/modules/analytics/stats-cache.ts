import { createHash } from "node:crypto";
import { StatsCache } from "./models/StatsCache.js";
import { runAfterResponse } from "../../shared/utils/after-response.js";

const TTL_BY_RANGE_MS: Record<string, number> = {
  "1h": 30_000,
  "24h": 120_000,
  "7d": 300_000,
  "30d": 600_000,
};
const DEFAULT_TTL_MS = 300_000;
const MAX_PAYLOAD_CHARS = 1_000_000;

export function statsTtlFor(rangeKey: string): number {
  return TTL_BY_RANGE_MS[rangeKey] ?? DEFAULT_TTL_MS;
}

async function readPayload(key: string): Promise<string | null> {
  try {
    const row = await StatsCache.findOne({ key, expiresAt: { $gt: new Date() } }).select("payload").lean();
    return row?.payload ?? null;
  } catch (e) {
    console.error("[stats-cache] read failed:", (e as Error).message);
    return null;
  }
}

async function writePayload(key: string, payload: string, ttlMs: number): Promise<void> {
  await StatsCache.updateOne(
    { key },
    { $set: { payload, expiresAt: new Date(Date.now() + ttlMs) } },
    { upsert: true },
  );
}

export async function sharedStats<T>(parts: unknown[], ttlMs: number, load: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");

  const cached = await readPayload(key);
  if (cached) return JSON.parse(cached) as T;

  const fresh = await load();
  const payload = JSON.stringify(fresh);
  if (payload.length <= MAX_PAYLOAD_CHARS) {
    runAfterResponse("stats cache write", () => writePayload(key, payload, ttlMs));
  }
  return fresh;
}
