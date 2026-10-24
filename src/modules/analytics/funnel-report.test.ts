import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildFunnelReport, fillTrend, funnelCacheKey, percent, trendUnitFor, type FunnelStep } from "./funnel-report.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const STEPS: FunnelStep[] = [
  { type: "page", value: "/" },
  { type: "page", value: "/pricing" },
  { type: "event", value: "signup_started" },
  { type: "event", value: "signup_completed" },
];
const SINCE = new Date("2026-10-17T00:00:00.000Z");
const UNTIL = new Date("2026-10-24T00:00:00.000Z");
const WINDOW = { since: SINCE, until: UNTIL, prevSince: new Date("2026-10-10T00:00:00.000Z"), prevUntil: SINCE };

describe("percent", () => {
  test("rounds to one decimal", () => {
    assert.equal(percent(884, 18402), 4.8);
    assert.equal(percent(1, 3), 33.3);
  });

  test("is zero when nothing entered", () => {
    assert.equal(percent(5, 0), 0);
  });
});

describe("trendUnitFor", () => {
  test("picks a bucket size that keeps the chart readable", () => {
    assert.equal(trendUnitFor(HOUR), "5min");
    assert.equal(trendUnitFor(DAY), "hour");
    assert.equal(trendUnitFor(30 * DAY), "day");
    assert.equal(trendUnitFor(365 * DAY), "week");
  });
});

describe("fillTrend", () => {
  test("returns one point per bucket and fills gaps with zero", () => {
    const points = fillTrend(
      [{ at: Date.parse("2026-10-18T00:00:00.000Z"), entered: 200, completed: 9 }],
      SINCE,
      UNTIL,
      "day",
    );
    assert.equal(points.length, 7);
    assert.deepEqual(points[0], { at: "2026-10-17T00:00:00.000Z", entered: 0, completed: 0, conversion: 0 });
    assert.deepEqual(points[1], { at: "2026-10-18T00:00:00.000Z", entered: 200, completed: 9, conversion: 4.5 });
  });
});

describe("buildFunnelReport", () => {
  const report = buildFunnelReport({
    steps: STEPS,
    current: { counts: [18402, 6991, 1767, 884], avgMsFromPrev: [null, 42_400, 95_600, null] },
    previous: { counts: [19000, 6800, 1600, 800], avgMsFromPrev: [null, null, null, null] },
    buckets: [],
    window: WINDOW,
    unit: "day",
  });

  test("reports each step against the first and the previous step", () => {
    assert.deepEqual(report.steps[0], {
      label: "/",
      type: "page",
      count: 18402,
      rate: 100,
      stepRate: 100,
      dropFromPrev: 0,
      dropped: 0,
      avgSecondsFromPrev: null,
      previousCount: 19000,
    });
    assert.deepEqual(report.steps[1], {
      label: "/pricing",
      type: "page",
      count: 6991,
      rate: 38,
      stepRate: 38,
      dropFromPrev: 62,
      dropped: 11411,
      avgSecondsFromPrev: 42,
      previousCount: 6800,
    });
    assert.equal(report.steps[2].stepRate, 25.3);
    assert.equal(report.steps[3].stepRate, 50);
    assert.equal(report.steps[3].avgSecondsFromPrev, null);
  });

  test("summarises both periods", () => {
    assert.deepEqual(report.current, {
      since: SINCE.toISOString(),
      until: UNTIL.toISOString(),
      entered: 18402,
      completed: 884,
      conversion: 4.8,
    });
    assert.equal(report.previous?.conversion, 4.2);
    assert.equal(report.previous?.since, "2026-10-10T00:00:00.000Z");
  });

  test("names the biggest drop by sessions lost, not by percentage", () => {
    assert.deepEqual(report.biggestDrop, { index: 1, dropped: 11411, dropFromPrev: 62 });
  });

  test("leaves previous counts empty when not comparing", () => {
    const solo = buildFunnelReport({
      steps: STEPS.slice(0, 2),
      current: { counts: [10, 0], avgMsFromPrev: [null, null] },
      previous: null,
      buckets: [],
      window: WINDOW,
      unit: "day",
    });
    assert.equal(solo.previous, null);
    assert.equal(solo.steps[1].previousCount, null);
    assert.equal(solo.steps[1].dropFromPrev, 100);
  });

  test("handles a funnel nobody entered", () => {
    const empty = buildFunnelReport({
      steps: STEPS.slice(0, 2),
      current: { counts: [0, 0], avgMsFromPrev: [null, null] },
      previous: null,
      buckets: [],
      window: WINDOW,
      unit: "day",
    });
    assert.equal(empty.steps[0].rate, 0);
    assert.equal(empty.steps[1].dropFromPrev, 0);
    assert.equal(empty.biggestDrop, null);
    assert.equal(empty.current.conversion, 0);
  });
});

describe("funnelCacheKey", () => {
  const base = {
    workspaceId: "w1",
    siteIds: ["b", "a"],
    steps: STEPS,
    since: new Date("2026-10-17T00:00:10.000Z"),
    until: new Date("2026-10-24T00:00:20.000Z"),
    compare: true,
    rangeKey: "7d",
  };

  test("treats the same minute of a live range as one request", () => {
    assert.equal(
      funnelCacheKey(base),
      funnelCacheKey({ ...base, siteIds: ["a", "b"], since: new Date("2026-10-17T00:00:40.000Z") }),
    );
  });

  test("changes with every input that changes the answer", () => {
    const key = funnelCacheKey(base);
    assert.notEqual(key, funnelCacheKey({ ...base, workspaceId: "w2" }));
    assert.notEqual(key, funnelCacheKey({ ...base, compare: false }));
    assert.notEqual(key, funnelCacheKey({ ...base, steps: STEPS.slice(0, 2) }));
    assert.notEqual(key, funnelCacheKey({ ...base, siteIds: ["a"] }));
    assert.notEqual(key, funnelCacheKey({ ...base, rangeKey: "30d" }));
  });

  test("keeps exact bounds for custom ranges", () => {
    const custom = { ...base, rangeKey: "custom" };
    assert.notEqual(funnelCacheKey(custom), funnelCacheKey({ ...custom, since: new Date("2026-10-17T00:00:40.000Z") }));
  });
});
