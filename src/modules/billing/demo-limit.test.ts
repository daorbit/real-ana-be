import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { demoUsageSnapshot, tryStartDemo } from "./demo-limit.js";
import { DemoStart } from "./models/DemoStart.js";
import { hashIp } from "../../shared/utils/ip-hash.js";
import { fakeQuery } from "../../test-support/mongoose-fakes.js";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

before(() => {
  process.env.JWT_SECRET = "test-jwt-secret";
});

describe("tryStartDemo", () => {
  test("lets a visitor under the limit start and records the start", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const find = t.mock.method(DemoStart, "find", () => fakeQuery([{ createdAt: new Date(NOW - 1000) }]));
    const create = t.mock.method(DemoStart, "create", async () => ({}));

    assert.deepEqual(await tryStartDemo("1.2.3.4", 3), { allowed: true });
    const filter = find.mock.calls[0].arguments[0] as { ipHash: string; allowed: boolean; createdAt: { $gt: Date } };
    assert.equal(filter.ipHash, hashIp("1.2.3.4"));
    assert.equal(filter.allowed, true);
    assert.equal(filter.createdAt.$gt.getTime(), NOW - DAY);
    assert.deepEqual(create.mock.calls[0].arguments[0], { ipHash: hashIp("1.2.3.4"), allowed: true });
  });

  test("never stores the raw address", async (t) => {
    const find = t.mock.method(DemoStart, "find", () => fakeQuery([]));
    const create = t.mock.method(DemoStart, "create", async () => ({}));
    await tryStartDemo("203.0.113.9", 1);
    assert.equal(JSON.stringify(find.mock.calls[0].arguments).includes("203.0.113.9"), false);
    assert.equal(JSON.stringify(create.mock.calls[0].arguments).includes("203.0.113.9"), false);
  });

  test("refuses at the limit and says when the oldest start ages out", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const oldest = new Date(NOW - 5 * 60 * 60 * 1000);
    t.mock.method(DemoStart, "find", () => fakeQuery([{ createdAt: oldest }, { createdAt: new Date(NOW - 1000) }]));
    const create = t.mock.method(DemoStart, "create", async () => ({}));

    const attempt = await tryStartDemo("1.2.3.4", 2);
    assert.deepEqual(attempt, { allowed: false, retryAt: new Date(oldest.getTime() + DAY) });
    assert.deepEqual(create.mock.calls[0].arguments[0], { ipHash: hashIp("1.2.3.4"), allowed: false });
  });
});

describe("demoUsageSnapshot", () => {
  test("reports starts, distinct addresses and refusals for the last day", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const count = t.mock.method(DemoStart, "countDocuments", (filter: { allowed: boolean }) =>
      fakeQuery(filter.allowed ? 12 : 4),
    );
    t.mock.method(DemoStart, "distinct", () => fakeQuery(["a", "b", "c"]));

    assert.deepEqual(await demoUsageSnapshot(), {
      today: 12,
      activeIps: 3,
      blocked: 4,
      since: new Date(NOW - DAY).toISOString(),
    });
    assert.equal(count.mock.callCount(), 2);
  });
});
