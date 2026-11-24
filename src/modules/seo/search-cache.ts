import { createHash } from "node:crypto";
import { SearchConsoleCache } from "./models/SearchConsoleCache.js";

export type SiteRef = {
  workspaceId: string;
  siteId: string;
  connectionId: string;
  propertyUrl: string;
  domain?: string;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MEMORY_ENTRIES = 60;
const LASTING = "lasting:";

const memory = new Map<string, { data: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();

export function hashKey(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function remember(key: string, data: unknown, expiresAt: number) {
  memory.delete(key);
  memory.set(key, { data, expiresAt });
  while (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string);
}

async function loadCached<T>(site: SiteRef, key: string, load: () => Promise<T>, ttlMs: number): Promise<T> {
  const hit = await SearchConsoleCache.findOne({ siteId: site.siteId, key }).lean();
  if (hit && hit.expiresAt.getTime() > Date.now()) {
    remember(`${site.siteId}|${key}`, hit.data, hit.expiresAt.getTime());
    return hit.data as T;
  }

  const data = await load();
  const expiresAt = Date.now() + ttlMs;
  remember(`${site.siteId}|${key}`, data, expiresAt);
  await SearchConsoleCache.findOneAndUpdate(
    { siteId: site.siteId, key },
    {
      workspaceId: site.workspaceId,
      siteId: site.siteId,
      key,
      data,
      expiresAt: new Date(expiresAt),
    },
    { upsert: true },
  );
  return data;
}

export async function cached<T>(
  site: SiteRef,
  key: string,
  load: () => Promise<T>,
  ttlMs: number = CACHE_TTL_MS,
): Promise<T> {
  const memoryKey = `${site.siteId}|${key}`;
  const hot = memory.get(memoryKey);
  if (hot && hot.expiresAt > Date.now()) return hot.data as T;

  const running = inflight.get(memoryKey);
  if (running) return running as Promise<T>;

  const pending = loadCached(site, key, load, ttlMs).finally(() => inflight.delete(memoryKey));
  inflight.set(memoryKey, pending);
  return pending;
}

export async function isCached(site: SiteRef, key: string): Promise<boolean> {
  const hot = memory.get(`${site.siteId}|${key}`);
  if (hot && hot.expiresAt > Date.now()) return true;
  const hit = await SearchConsoleCache.findOne({ siteId: site.siteId, key }).select("expiresAt").lean();
  return Boolean(hit && hit.expiresAt.getTime() > Date.now());
}

export async function forgetCached(site: SiteRef, key: string): Promise<void> {
  memory.delete(`${site.siteId}|${key}`);
  await SearchConsoleCache.deleteOne({ siteId: site.siteId, key });
}

export async function clearSiteCache(siteId: string): Promise<void> {
  for (const key of [...memory.keys()]) if (key.startsWith(`${siteId}|`)) memory.delete(key);
  await SearchConsoleCache.deleteMany({ siteId, key: { $not: new RegExp(`^${LASTING}`) } });
}

export async function saveLasting(site: SiteRef, key: string, data: unknown, ttlMs: number): Promise<void> {
  await SearchConsoleCache.updateOne(
    { siteId: site.siteId, key: `${LASTING}${key}` },
    { $set: { workspaceId: site.workspaceId, data, expiresAt: new Date(Date.now() + ttlMs) } },
    { upsert: true },
  );
}

export async function loadLasting<T>(site: SiteRef, prefix: string, limit: number): Promise<T[]> {
  const rows = await SearchConsoleCache.find({
    siteId: site.siteId,
    key: new RegExp(`^${LASTING}${prefix}`),
    expiresAt: { $gt: new Date() },
  })
    .select("data")
    .limit(limit)
    .lean();
  return rows.map((row) => row.data as T);
}
