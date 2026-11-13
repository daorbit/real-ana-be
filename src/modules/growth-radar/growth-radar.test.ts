import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { trafficWithoutLeads } from "./detectors/traffic-without-leads.js";
import { formRateDecline } from "./detectors/form-rate-decline.js";
import { groundedReply } from "./explain.js";
import { prioritise } from "./priority.js";
import { groupSignals } from "./aggregate.js";
import { completeDays, nextScanAfter, rangeFor } from "./windows.js";
import type { RadarData } from "./sources/index.js";
import type { DetectorResult, Signal } from "./types.js";

const NOW = new Date("2026-11-13T10:00:00Z");

function totals(sessions: number) {
  return { pageviews: sessions * 2, visitors: sessions, sessions, avgTimeOnPageMs: 0, avgSessionMs: 0, bounceRate: 0, pagesPerSession: 2 };
}

function data(partial: { sessions?: [number, number]; leads?: [number, number]; forms?: RadarData["forms"] }): RadarData {
  const [now, before] = partial.sessions ?? [0, 0];
  const [leadsNow, leadsBefore] = partial.leads ?? [0, 0];
  const week = completeDays(7, NOW);
  return {
    now: NOW,
    statuses: [],
    search: null,
    analytics: {
      sites: [{ siteId: "s1", name: "Acme", domain: "acme.co" }],
      siteIds: ["s1"],
      week: { window: week, current: totals(now), previous: totals(before) },
      entryPages: { window: completeDays(28, NOW), rows: [], totalSessions: 0 },
    },
    forms: partial.forms ?? {
      formCount: 1,
      performance: [],
      formWindow: rangeFor(30, NOW),
      leadsWeek: { window: week, current: leadsNow, previous: leadsBefore },
      leadPages: null,
      bookingFormIds: [],
    },
  };
}

function signals(result: ReturnType<typeof trafficWithoutLeads.run>): Signal[] {
  assert.ok(!("skipped" in result));
  return (result as DetectorResult).signals;
}

describe("windows", () => {
  test("compares complete UTC days only", () => {
    const w = completeDays(7, NOW);
    assert.equal(w.until.toISOString(), "2026-11-13T00:00:00.000Z");
    assert.equal(w.since.toISOString(), "2026-11-06T00:00:00.000Z");
    assert.equal(w.prevSince.toISOString(), "2026-10-30T00:00:00.000Z");
  });

  test("schedules the next scan for the coming morning", () => {
    assert.equal(nextScanAfter(NOW, 6).toISOString(), "2026-11-14T06:00:00.000Z");
    assert.equal(nextScanAfter(new Date("2026-11-13T05:00:00Z"), 6).toISOString(), "2026-11-13T06:00:00.000Z");
  });
});

describe("trafficWithoutLeads", () => {
  test("flags sessions rising while leads stay flat", () => {
    const found = signals(trafficWithoutLeads.run(data({ sessions: [1400, 1000], leads: [20, 20] }), 20));
    assert.equal(found.length, 1);
    assert.equal(found[0].fingerprint, "trafficWithoutLeads:workspace");
    assert.equal(found[0].metrics.find((m) => m.key === "leadRate")?.current, 1.4);
  });

  test("stays quiet when leads rise with the traffic", () => {
    assert.equal(signals(trafficWithoutLeads.run(data({ sessions: [1400, 1000], leads: [28, 20] }), 20)).length, 0);
  });

  test("needs enough sessions and leads to compare", () => {
    assert.equal(signals(trafficWithoutLeads.run(data({ sessions: [90, 50], leads: [2, 2] }), 20)).length, 0);
  });

  test("always returns a reading for outcome tracking", () => {
    const result = trafficWithoutLeads.run(data({ sessions: [1400, 1000], leads: [20, 20] }), 20) as DetectorResult;
    assert.equal(result.readings[0].metric, "leadRate");
  });
});

describe("formRateDecline", () => {
  const form = (views: number, responses: number, previousViews: number, previousResponses: number) => ({
    id: "f1",
    title: "Contact",
    status: "published" as const,
    views,
    responses,
    previousViews,
    previousResponses,
  });

  const withForms = (performance: ReturnType<typeof form>[]) =>
    data({
      forms: {
        formCount: 1,
        performance,
        formWindow: rangeFor(30, NOW),
        leadsWeek: null,
        leadPages: null,
        bookingFormIds: [],
      },
    });

  test("flags a form whose rate fell past the threshold", () => {
    const found = signals(formRateDecline.run(withForms([form(800, 36, 750, 54)]), 30));
    assert.equal(found.length, 1);
    assert.equal(found[0].entity.key, "f1");
  });

  test("ignores forms with too few views", () => {
    assert.equal(signals(formRateDecline.run(withForms([form(40, 1, 60, 6)]), 30)).length, 0);
  });

  test("skips when lead capture has no previous figures yet", () => {
    const result = formRateDecline.run(
      withForms([{ ...form(800, 36, 0, 0), previousViews: undefined, previousResponses: undefined } as never]),
      30,
    );
    assert.ok("skipped" in result);
  });
});

describe("groundedReply", () => {
  const signal = signals(trafficWithoutLeads.run(data({ sessions: [1400, 1000], leads: [20, 20] }), 20))[0];

  test("keeps a summary that only uses the finding's numbers", () => {
    const reply = "You had 1,400 sessions last week, up 40%, but leads stayed at 20. That gap is worth a look before you spend more on traffic.";
    assert.ok(groundedReply(reply, signal));
  });

  test("drops a summary with an invented number", () => {
    const reply = "You had 1,400 sessions last week, but only 12 leads came in. That gap is worth a look before you spend more.";
    assert.equal(groundedReply(reply, signal), null);
  });

  test("drops a summary that claims a cause", () => {
    const reply = "Leads stayed at 20 because your new traffic came from the wrong audience, which is worth a closer look.";
    assert.equal(groundedReply(reply, signal), null);
  });
});

describe("prioritise", () => {
  test("never ranks a low-confidence finding as high", () => {
    const result = prioritise({
      impact: { level: "high", reason: "" },
      confidence: { level: "low", reason: "" },
      urgency: { level: "high", reason: "" },
      effort: { level: "low", reason: "" },
    });
    assert.equal(result.priority, "medium");
  });
});

describe("groupSignals", () => {
  test("folds a form decline into the booking finding for the same form", () => {
    const base = signals(trafficWithoutLeads.run(data({ sessions: [1400, 1000], leads: [20, 20] }), 20))[0];
    const grouped = groupSignals([
      { ...base, detector: "formRateDecline", fingerprint: "formRateDecline:f1" },
      { ...base, detector: "bookingDecline", fingerprint: "bookingDecline:f1", limitations: [] },
    ]);
    assert.deepEqual(grouped.map((s) => s.fingerprint), ["bookingDecline:f1"]);
    assert.equal(grouped[0].limitations.length, 1);
  });
});
