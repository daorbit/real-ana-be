type Entry<T> = { value: Promise<T>; expires: number };

export function createTtlCache<T>(ttlMs: number, maxEntries = 2_000) {
  const store = new Map<string, Entry<T>>();

  return (key: string, load: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) return hit.value;

    if (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }

    const value = load();
    store.set(key, { value, expires: now + ttlMs });
    value.catch(() => store.delete(key));
    return value;
  };
}
