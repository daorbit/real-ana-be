import type { Response } from "express";
import { Types } from "mongoose";
import { ApiKey } from "./models/ApiKey.js";
import { ApiKeyUsage } from "./models/ApiKeyUsage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export async function recordKeyRequest(keyId: string, workspaceId: string): Promise<void> {
  const now = new Date();
  try {
    await Promise.all([
      ApiKey.updateOne({ _id: keyId }, { $set: { lastUsedAt: now }, $inc: { requestCount: 1 } }),
      ApiKeyUsage.updateOne(
        { keyId, day: utcDay(now) },
        { $inc: { requests: 1 }, $setOnInsert: { workspaceId } },
        { upsert: true },
      ),
    ]);
  } catch (e) {
    console.error("[api-key-usage] request increment failed:", (e as Error).message);
  }
}

export function watchKeyFailures(res: Response, keyId: string): void {
  res.on("finish", () => {
    if (res.statusCode < 400) return;
    ApiKeyUsage.updateOne(
      { keyId, day: utcDay(new Date()) },
      { $inc: { failures: 1 } },
    ).catch(() => {});
  });
}

export function parseUsageWindow(raw: unknown): UsageWindow {
  const n = Number(raw);
  return (USAGE_WINDOWS as readonly number[]).includes(n) ? (n as UsageWindow) : 30;
}

export async function workspaceKeyUsage(workspaceId: string, windowDays: UsageWindow) {
  const today = utcDay(new Date());
  const start = new Date(today.getTime() - (windowDays - 1) * DAY_MS);
  const previousStart = new Date(start.getTime() - windowDays * DAY_MS);

  const rows = await ApiKeyUsage.find({
    workspaceId: new Types.ObjectId(workspaceId),
    day: { $gte: previousStart },
  })
    .select("keyId day requests failures")
    .lean();

  const dayIndex = new Map<string, number>();
  const days = Array.from({ length: windowDays }, (_, i) => {
    const date = dayKey(new Date(start.getTime() + i * DAY_MS));
    dayIndex.set(date, i);
    return { date, requests: 0, failures: 0 };
  });

  type KeyEntry = {
    keyId: string;
    requests: number;
    failures: number;
    previous: { requests: number; failures: number };
    series: { requests: number[]; failures: number[] };
  };

  const byKey = new Map<string, KeyEntry>();
  const previous = { requests: 0, failures: 0 };

  const entryFor = (keyId: string): KeyEntry => {
    let entry = byKey.get(keyId);
    if (!entry) {
      entry = {
        keyId,
        requests: 0,
        failures: 0,
        previous: { requests: 0, failures: 0 },
        series: { requests: new Array(windowDays).fill(0), failures: new Array(windowDays).fill(0) },
      };
      byKey.set(keyId, entry);
    }
    return entry;
  };

  for (const row of rows) {
    const requests = row.requests ?? 0;
    const failures = row.failures ?? 0;
    const entry = entryFor(String(row.keyId));
    const at = dayIndex.get(dayKey(row.day));

    if (at === undefined) {
      previous.requests += requests;
      previous.failures += failures;
      entry.previous.requests += requests;
      entry.previous.failures += failures;
      continue;
    }

    days[at].requests += requests;
    days[at].failures += failures;
    entry.requests += requests;
    entry.failures += failures;
    entry.series.requests[at] += requests;
    entry.series.failures[at] += failures;
  }

  return {
    windowDays,
    days,
    keys: [...byKey.values()],
    previous,
  };
}
