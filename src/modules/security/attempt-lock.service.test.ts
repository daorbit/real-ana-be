import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimAttempt, clearAttempts } from "./attempt-lock.service.js";
import { AttemptLock } from "./models/AttemptLock.js";
import { fakeQuery } from "../../test-support/mongoose-fakes.js";

const NOW = Date.UTC(2026, 9, 24, 9, 0, 0);
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

describe("claimAttempt", () => {
  test("returns the existing lock without counting while it is active", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const lockedUntil = new Date(NOW + 60_000);
    t.mock.method(AttemptLock, "findOne", () => fakeQuery({ lockedUntil }));
    const count = t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery({ attempts: 1 }));

    assert.equal(await claimAttempt("confirm:u1"), lockedUntil);
    assert.equal(count.mock.callCount(), 0);
  });

  test("counts the attempt and allows it while under five", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    t.mock.method(AttemptLock, "findOne", () => fakeQuery({ lockedUntil: new Date(NOW - 1) }));
    const count = t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery({ attempts: 5 }));
    const lock = t.mock.method(AttemptLock, "updateOne", async () => ({}));

    assert.equal(await claimAttempt("confirm:u1"), null);
    const [filter, change, options] = count.mock.calls[0].arguments as [
      { key: string },
      { $inc: { attempts: number }; $set: { lockedUntil: null; expiresAt: Date } },
      { upsert: boolean },
    ];
    assert.deepEqual(filter, { key: "confirm:u1" });
    assert.deepEqual(change.$inc, { attempts: 1 });
    assert.equal(change.$set.lockedUntil, null);
    assert.equal(change.$set.expiresAt.getTime(), NOW + ONE_HOUR);
    assert.equal(options.upsert, true);
    assert.equal(lock.mock.callCount(), 0);
  });

  test("locks for fifteen minutes on the sixth attempt and resets the count", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    t.mock.method(AttemptLock, "findOne", () => fakeQuery(null));
    t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery({ attempts: 6 }));
    const lock = t.mock.method(AttemptLock, "updateOne", async () => ({}));

    const lockedUntil = await claimAttempt("confirm:u1");
    assert.equal(lockedUntil?.getTime(), NOW + FIFTEEN_MINUTES);
    const [filter, change] = lock.mock.calls[0].arguments as [
      { key: string },
      { $set: { attempts: number; lockedUntil: Date; expiresAt: Date } },
    ];
    assert.deepEqual(filter, { key: "confirm:u1" });
    assert.equal(change.$set.attempts, 0);
    assert.equal(change.$set.lockedUntil.getTime(), NOW + FIFTEEN_MINUTES);
    assert.equal(change.$set.expiresAt.getTime(), NOW + FIFTEEN_MINUTES);
  });

  test("treats a missing counter as a first attempt", async (t) => {
    t.mock.method(AttemptLock, "findOne", () => fakeQuery(null));
    t.mock.method(AttemptLock, "findOneAndUpdate", () => fakeQuery(null));
    assert.equal(await claimAttempt("k"), null);
  });
});

describe("clearAttempts", () => {
  test("removes the counter for the key", async (t) => {
    const remove = t.mock.method(AttemptLock, "deleteOne", async () => ({ deletedCount: 1 }));
    await clearAttempts("confirm:u1");
    assert.deepEqual(remove.mock.calls[0].arguments[0], { key: "confirm:u1" });
  });
});
