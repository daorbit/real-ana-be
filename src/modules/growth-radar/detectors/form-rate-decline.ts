import { levelAtLeast } from "../priority.js";
import type { Factors, Reading, Signal } from "../types.js";
import { fmt, pctText, ratePct } from "./format.js";
import type { DetectorSpec } from "./spec.js";

const MIN_PREVIOUS_VIEWS = 100;
const MIN_VIEWS = 50;
const MIN_PREVIOUS_RESPONSES = 5;
const MAX_FORMS = 3;

export const formRateDecline: DetectorSpec = {
  id: "formRateDecline",
  version: 1,
  category: "form_performance",
  requires: ["leadCapture"],
  threshold: { default: 30, min: 10, max: 80, step: 5 },
  run(data, threshold) {
    const forms = data.forms!;
    const rows = forms.performance.filter((r) => r.status === "published");
    if (rows.length && rows.every((r) => r.previousViews === undefined)) {
      return { skipped: "Lead capture has to be updated before form rates can be compared." };
    }

    const window = forms.formWindow;
    const readings: Reading[] = [];
    const flagged: { row: (typeof rows)[number]; rateNow: number; rateBefore: number; drop: number; expected: number }[] = [];

    for (const row of rows) {
      const previousViews = row.previousViews ?? 0;
      const previousResponses = row.previousResponses ?? 0;
      if (row.views < MIN_VIEWS) continue;
      const rateNow = ratePct(row.responses, row.views);
      readings.push({ fingerprint: `formRateDecline:${row.id}`, metric: "completionRate", value: rateNow, periodStart: window.since, periodEnd: window.until });
      if (previousViews < MIN_PREVIOUS_VIEWS || previousResponses < MIN_PREVIOUS_RESPONSES) continue;
      const rateBefore = ratePct(previousResponses, previousViews);
      if (rateBefore <= 0) continue;
      const drop = Math.round(((rateBefore - rateNow) / rateBefore) * 100);
      if (drop < threshold) continue;
      flagged.push({ row, rateNow, rateBefore, drop, expected: Math.round((row.views * rateBefore) / 100) });
    }

    const signals = flagged
      .sort((a, b) => b.expected - b.row.responses - (a.expected - a.row.responses))
      .slice(0, MAX_FORMS)
      .map(({ row, rateNow, rateBefore, drop, expected }): Signal => {
        const lost = Math.max(0, expected - row.responses);
        const previousViews = row.previousViews ?? 0;
        const factors: Factors = {
          impact: {
            level: levelAtLeast(lost, 15, 5),
            reason: `At its earlier rate this form would have about ${fmt(expected)} responses from these views, and it has ${fmt(row.responses)}.`,
          },
          confidence:
            previousViews >= 500 && row.views >= 300
              ? { level: "high", reason: "Both periods have plenty of views." }
              : previousViews >= 200
                ? { level: "medium", reason: "Enough views to compare, though the counts are modest." }
                : { level: "low", reason: "The numbers are small, so this could be chance." },
          urgency:
            drop >= threshold * 2
              ? { level: "high", reason: "A sharp drop over the last 30 days." }
              : { level: "medium", reason: "A steady drop over the last 30 days." },
          effort: { level: "low", reason: "Usually a form fix: a field, a step or a validation rule." },
        };
        return {
          detector: "formRateDecline",
          fingerprint: `formRateDecline:${row.id}`,
          category: "form_performance",
          entity: { type: "form", key: row.id, label: row.title || "Untitled form" },
          title: `“${row.title || "Untitled form"}” turns fewer views into responses`,
          summary: `${pctText(rateNow)} of views became a response in the last 30 days, down from ${pctText(rateBefore)} in the 30 days before (${fmt(row.responses)} responses from ${fmt(row.views)} views).`,
          whyItMatters:
            "People still open the form, but more of them leave without sending it. That usually points to something in the form itself rather than your traffic.",
          nextSteps: [
            "Open the form and fill it in yourself on a phone and a computer, all the way to the thank-you page.",
            "Check recent edits: new required fields, extra steps or a changed submit button.",
            "If partial responses are on, open Lead insights to see the question where people stop.",
            "Check where the form is shown. A popup or a new page can add views from people who never meant to answer.",
          ],
          limitations: [
            "The latest period includes today so far.",
            "A view is counted each time the form loads, not once per person.",
            "Device and validation error details are not part of this check.",
          ],
          metrics: [
            { key: "views", label: "Views", current: row.views, previous: previousViews, unit: "count" },
            { key: "responses", label: "Responses", current: row.responses, previous: row.previousResponses ?? 0, unit: "count" },
            { key: "completionRate", label: "Views that became a response", current: rateNow, previous: rateBefore, unit: "percent" },
          ],
          primaryMetric: "completionRate",
          period: {
            start: window.since,
            end: window.until,
            previousStart: window.prevSince,
            previousEnd: window.prevUntil,
            days: window.days,
            includesToday: true,
          },
          sampleSize: row.views,
          sources: ["leadCapture"],
          factors,
        };
      });

    return { signals, readings };
  },
};
