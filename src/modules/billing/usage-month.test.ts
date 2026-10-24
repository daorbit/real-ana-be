import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nextUsageReset, rollUsageMonth, usageMonthKey } from "./usage-month.js";
import { Subscription } from "./models/Subscription.js";
import { UsageMonth } from "./models/UsageMonth.js";
import { fakeDoc, fakeQuery } from "../../test-support/mongoose-fakes.js";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
let counter = 0;

function freshWorkspaceId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, "a");
}

describe("usageMonthKey", () => {
  test("is the UTC year and month", () => {
    assert.equal(usageMonthKey(new Date("2026-10-31T23:59:59Z")), "2026-10");
    assert.equal(usageMonthKey(new Date("2026-11-01T00:00:00Z")), "2026-11");
  });
});

describe("nextUsageReset", () => {
  test("is the first moment of next month in UTC", () => {
    assert.equal(nextUsageReset(new Date("2026-10-24T12:00:00Z")).toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(nextUsageReset(new Date("2026-12-31T23:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  });
});

describe("rollUsageMonth", () => {
  test("starts a fresh month, zeroes the counters and archives last month", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const wid = freshWorkspaceId();
    const stamp = t.mock.method(Subscription, "updateOne", async () => ({}));
    const previous = fakeDoc({
      workspaceId: wid,
      usageMonth: "2026-09",
      planSlug: "starter",
      orbitPlanSlug: "orbit-pro",
      eventsUsed: 1200,
      auditsUsed: 3,
      crawlsUsed: 1,
      inspectionsUsed: 0,
      formSubmissionsUsed: 40,
      orbitUsed: 9,
    });
    const roll = t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(previous));
    const archive = t.mock.method(UsageMonth, "updateOne", async () => ({}));

    await rollUsageMonth(wid);

    assert.deepEqual(stamp.mock.calls[0].arguments.slice(0, 2), [
      { workspaceId: wid, usageMonth: null },
      { $set: { usageMonth: "2026-10" } },
    ]);
    const [rollFilter, rollChange, rollOptions] = roll.mock.calls[0].arguments as [unknown, { $set: Record<string, unknown> }, unknown];
    assert.deepEqual(rollFilter, { workspaceId: wid, usageMonth: { $ne: "2026-10" } });
    assert.deepEqual(rollChange.$set, {
      usageMonth: "2026-10",
      eventsUsed: 0,
      auditsUsed: 0,
      crawlsUsed: 0,
      inspectionsUsed: 0,
      formSubmissionsUsed: 0,
      orbitUsed: 0,
    });
    assert.deepEqual(rollOptions, { returnDocument: "before" });

    const [archiveFilter, archiveChange, archiveOptions] = archive.mock.calls[0].arguments as [
      unknown,
      { $set: Record<string, unknown> },
      unknown,
    ];
    assert.deepEqual(archiveFilter, { workspaceId: wid, month: "2026-09" });
    assert.deepEqual(
      { ...archiveChange.$set, closedAt: undefined },
      {
        events: 1200,
        audits: 3,
        crawls: 1,
        inspections: 0,
        formSubmissions: 40,
        orbit: 9,
        planSlug: "starter",
        orbitPlanSlug: "orbit-pro",
        closedAt: undefined,
      },
    );
    assert.ok(archiveChange.$set.closedAt instanceof Date);
    assert.deepEqual(archiveOptions, { upsert: true });
  });

  test("does nothing more once the month is settled for a workspace", async (t) => {
    const wid = freshWorkspaceId();
    t.mock.method(Subscription, "updateOne", async () => ({}));
    const roll = t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(null));
    await rollUsageMonth(wid);
    await rollUsageMonth(wid);
    assert.equal(roll.mock.callCount(), 1);
  });

  test("skips the archive when the month already rolled", async (t) => {
    const wid = freshWorkspaceId();
    t.mock.method(Subscription, "updateOne", async () => ({}));
    t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(null));
    const archive = t.mock.method(UsageMonth, "updateOne", async () => ({}));
    await rollUsageMonth(wid);
    assert.equal(archive.mock.callCount(), 0);
  });

  test("skips the archive for a subscription that never had a month", async (t) => {
    const wid = freshWorkspaceId();
    t.mock.method(Subscription, "updateOne", async () => ({}));
    t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(fakeDoc({ workspaceId: wid, usageMonth: null })));
    const archive = t.mock.method(UsageMonth, "updateOne", async () => ({}));
    await rollUsageMonth(wid);
    assert.equal(archive.mock.callCount(), 0);
  });

  test("archives missing counters as zero and a missing plan as empty", async (t) => {
    const wid = freshWorkspaceId();
    t.mock.method(Subscription, "updateOne", async () => ({}));
    t.mock.method(Subscription, "findOneAndUpdate", () => fakeQuery(fakeDoc({ workspaceId: wid, usageMonth: "2026-01" })));
    const archive = t.mock.method(UsageMonth, "updateOne", async () => ({}));
    await rollUsageMonth(wid);
    const change = archive.mock.calls[0].arguments[1] as { $set: Record<string, unknown> };
    assert.equal(change.$set.events, 0);
    assert.equal(change.$set.planSlug, "");
    assert.equal(change.$set.orbitPlanSlug, null);
  });
});
