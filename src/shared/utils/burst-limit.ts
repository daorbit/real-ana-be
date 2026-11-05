export function createBurstLimiter(limit: number, windowMs: number, maxKeys = 20_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      if (!entry && hits.size >= maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }

    entry.count += 1;
    return entry.count > limit;
  };
}
