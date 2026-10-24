import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { overRateLimit } from "./rate-limit.service.js";
import { RateCounter } from "./models/RateCounter.js";
import { duplicateKeyError, fakeQuery } from "../../test-support/mongoose-fakes.js";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 24, 10, 12, 30);

describe("overRateLimit", () => {
  test("allows calls up to the limit and refuses the one after", async (t) => {
    const counts = [1, 2, 3, 4];
    t.mock.method(RateCounter, "findOneAndUpdate", () => fakeQuery({ count: counts.shift() }));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await overRateLimit("login:1.2.3.4", 3, MINUTE));
    assert.deepEqual(results, [false, false, false, true]);
  });

  test("counts in fixed windows keyed by the window start", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const update = t.mock.method(RateCounter, "findOneAndUpdate", () => fakeQuery({ count: 1 }));
    await overRateLimit("api", 10, MINUTE);

    const windowStart = Math.floor(NOW / MINUTE) * MINUTE;
    const [filter, change, options] = update.mock.calls[0].arguments as [
      { key: string },
      { $inc: { count: number }; $setOnInsert: { expiresAt: Date } },
      { upsert: boolean; new: boolean },
    ];
    assert.equal(filter.key, `api:${windowStart}`);
    assert.deepEqual(change.$inc, { count: 1 });
    assert.equal(change.$setOnInsert.expiresAt.getTime(), windowStart + MINUTE);
    assert.equal(options.upsert, true);
    assert.equal(options.new, true);
  });

  test("treats a missing counter as zero", async (t) => {
    t.mock.method(RateCounter, "findOneAndUpdate", () => fakeQuery(null));
    assert.equal(await overRateLimit("x", 0, MINUTE), false);
  });

  test("retries when two first calls race on the same window", async (t) => {
    let calls = 0;
    const update = t.mock.method(RateCounter, "findOneAndUpdate", () => {
      calls += 1;
      if (calls === 1) throw duplicateKeyError();
      return fakeQuery({ count: 2 });
    });
    assert.equal(await overRateLimit("x", 1, MINUTE), true);
    assert.equal(update.mock.callCount(), 2);
  });
});
