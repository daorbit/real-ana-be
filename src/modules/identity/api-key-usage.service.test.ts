import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import { parseUsageWindow, recordKeyRequest, watchKeyFailures, workspaceKeyUsage } from "./api-key-usage.service.js";
import { ApiKey } from "./models/ApiKey.js";
import { ApiKeyUsage } from "./models/ApiKeyUsage.js";
import { fakeQuery } from "../../test-support/mongoose-fakes.js";

const WID = "66f1a2b3c4d5e6f708192a3b";
const KEY_A = "77f1a2b3c4d5e6f708192a3b";
const KEY_B = "88f1a2b3c4d5e6f708192a3b";
const NOW = Date.UTC(2026, 9, 24, 15, 30, 0);
const TODAY = new Date(Date.UTC(2026, 9, 24));
const DAY = 24 * 60 * 60 * 1000;

function finishedResponse(statusCode: number): Response {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res as unknown as Response;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("parseUsageWindow", () => {
  test("accepts 7, 30 and 90 days and defaults to 30", () => {
    assert.equal(parseUsageWindow("7"), 7);
    assert.equal(parseUsageWindow(90), 90);
    assert.equal(parseUsageWindow("14"), 30);
    assert.equal(parseUsageWindow(undefined), 30);
    assert.equal(parseUsageWindow("abc"), 30);
  });
});

describe("recordKeyRequest", () => {
  test("bumps the key's counter and today's usage row", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const key = t.mock.method(ApiKey, "updateOne", async () => ({}));
    const usage = t.mock.method(ApiKeyUsage, "updateOne", async () => ({}));

    await recordKeyRequest(KEY_A, WID);

    const [keyFilter, keyChange] = key.mock.calls[0].arguments as [unknown, { $set: { lastUsedAt: Date }; $inc: unknown }];
    assert.deepEqual(keyFilter, { _id: KEY_A });
    assert.equal(keyChange.$set.lastUsedAt.getTime(), NOW);
    assert.deepEqual(keyChange.$inc, { requestCount: 1 });
    assert.deepEqual(usage.mock.calls[0].arguments, [
      { keyId: KEY_A, day: TODAY },
      { $inc: { requests: 1 }, $setOnInsert: { workspaceId: WID } },
      { upsert: true },
    ]);
  });

  test("never fails the API request when counting fails", async (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.method(ApiKey, "updateOne", async () => {
      throw new Error("mongo down");
    });
    t.mock.method(ApiKeyUsage, "updateOne", async () => ({}));
    await assert.doesNotReject(recordKeyRequest(KEY_A, WID));
  });
});

describe("watchKeyFailures", () => {
  test("counts a failure when the response is an error", async (t) => {
    const usage = t.mock.method(ApiKeyUsage, "updateOne", async () => ({}));
    const res = finishedResponse(429);
    watchKeyFailures(res, KEY_A);
    (res as unknown as EventEmitter).emit("finish");
    await tick();
    assert.equal(usage.mock.callCount(), 1);
    assert.deepEqual(usage.mock.calls[0].arguments[1], { $inc: { failures: 1 } });
  });

  test("does not count successful responses", async (t) => {
    const usage = t.mock.method(ApiKeyUsage, "updateOne", async () => ({}));
    const res = finishedResponse(200);
    watchKeyFailures(res, KEY_A);
    (res as unknown as EventEmitter).emit("finish");
    await tick();
    assert.equal(usage.mock.callCount(), 0);
  });

  test("swallows errors from the failure counter", async (t) => {
    t.mock.method(ApiKeyUsage, "updateOne", () => Promise.reject(new Error("mongo down")));
    const res = finishedResponse(500);
    watchKeyFailures(res, KEY_A);
    (res as unknown as EventEmitter).emit("finish");
    await tick();
  });
});

describe("workspaceKeyUsage", () => {
  test("builds a daily series per key and totals the previous window separately", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const find = t.mock.method(ApiKeyUsage, "find", () =>
      fakeQuery([
        { keyId: KEY_A, day: TODAY, requests: 10, failures: 1 },
        { keyId: KEY_A, day: new Date(TODAY.getTime() - 6 * DAY), requests: 4, failures: 0 },
        { keyId: KEY_B, day: new Date(TODAY.getTime() - 2 * DAY), requests: 3, failures: 3 },
        { keyId: KEY_A, day: new Date(TODAY.getTime() - 9 * DAY), requests: 50, failures: 5 },
      ]),
    );

    const usage = await workspaceKeyUsage(WID, 7);

    assert.equal(usage.windowDays, 7);
    assert.equal(usage.days.length, 7);
    assert.equal(usage.days[0].date, "2026-10-18");
    assert.equal(usage.days[6].date, "2026-10-24");
    assert.deepEqual(usage.days[6], { date: "2026-10-24", requests: 10, failures: 1 });
    assert.deepEqual(usage.days[0], { date: "2026-10-18", requests: 4, failures: 0 });
    assert.deepEqual(usage.days[4], { date: "2026-10-22", requests: 3, failures: 3 });
    assert.deepEqual(usage.previous, { requests: 50, failures: 5 });

    const a = usage.keys.find((k) => k.keyId === KEY_A);
    assert.equal(a?.requests, 14);
    assert.equal(a?.failures, 1);
    assert.deepEqual(a?.previous, { requests: 50, failures: 5 });
    assert.deepEqual(a?.series.requests, [4, 0, 0, 0, 0, 0, 10]);
    const b = usage.keys.find((k) => k.keyId === KEY_B);
    assert.deepEqual(b?.series.failures, [0, 0, 0, 0, 3, 0, 0]);

    const filter = find.mock.calls[0].arguments[0] as { workspaceId: { toString(): string }; day: { $gte: Date } };
    assert.equal(filter.workspaceId.toString(), WID);
    assert.equal(filter.day.$gte.getTime(), TODAY.getTime() - 13 * DAY);
  });

  test("returns an empty window with no usage", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    t.mock.method(ApiKeyUsage, "find", () => fakeQuery([]));
    const usage = await workspaceKeyUsage(WID, 30);
    assert.equal(usage.days.length, 30);
    assert.ok(usage.days.every((d) => d.requests === 0 && d.failures === 0));
    assert.deepEqual(usage.keys, []);
    assert.deepEqual(usage.previous, { requests: 0, failures: 0 });
  });

  test("treats missing counts as zero", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    t.mock.method(ApiKeyUsage, "find", () => fakeQuery([{ keyId: KEY_A, day: TODAY }]));
    const usage = await workspaceKeyUsage(WID, 7);
    assert.deepEqual(usage.days[6], { date: "2026-10-24", requests: 0, failures: 0 });
  });
});
