import { AttemptLock } from "./models/AttemptLock.js";
import { retryOnDuplicateKey } from "./upsert.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const ATTEMPT_MEMORY_MS = 60 * 60 * 1000;

export async function claimAttempt(key: string): Promise<Date | null> {
  const now = Date.now();

  const existing = await AttemptLock.findOne({ key }).select("lockedUntil").lean();
  if (existing?.lockedUntil && existing.lockedUntil.getTime() > now) return existing.lockedUntil;

  const counted = await retryOnDuplicateKey(() =>
    AttemptLock.findOneAndUpdate(
      { key },
      {
        $inc: { attempts: 1 },
        $set: { lockedUntil: null, expiresAt: new Date(now + ATTEMPT_MEMORY_MS) },
      },
      { upsert: true, new: true, projection: { attempts: 1 } },
    ).lean(),
  );

  if ((counted?.attempts ?? 0) <= MAX_ATTEMPTS) return null;

  const lockedUntil = new Date(now + LOCK_MS);
  await AttemptLock.updateOne(
    { key },
    { $set: { attempts: 0, lockedUntil, expiresAt: lockedUntil } },
  );
  return lockedUntil;
}

export async function clearAttempts(key: string): Promise<void> {
  await AttemptLock.deleteOne({ key });
}
