import { RateCounter } from "./models/RateCounter.js";
import { retryOnDuplicateKey } from "./upsert.js";

export async function overRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  const counter = await retryOnDuplicateKey(() =>
    RateCounter.findOneAndUpdate(
      { key: `${key}:${windowStart}` },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs) } },
      { upsert: true, new: true, projection: { count: 1 } },
    ).lean(),
  );

  return (counter?.count ?? 0) > limit;
}
