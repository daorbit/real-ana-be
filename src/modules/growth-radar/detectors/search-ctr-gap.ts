import { levelAtLeast } from "../priority.js";
import { DAY_MS } from "../windows.js";
import { SEARCH_DAYS } from "../sources/search.source.js";
import type { Factors, Reading, Signal } from "../types.js";
import { changePct, fmt, pctText } from "./format.js";
import type { DetectorSpec } from "./spec.js";

const MIN_PREVIOUS_IMPRESSIONS = 1000;
const MIN_IMPRESSION_RISE = 20;

const round1 = (n: number) => Math.round(n * 10) / 10;

function dayOf(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export const searchCtrGap: DetectorSpec = {
  id: "searchCtrGap",
  version: 1,
  category: "search_visibility",
  requires: ["searchConsole"],
  threshold: { default: 15, min: 5, max: 60, step: 5 },
  run(data, threshold) {
    const readings: Reading[] = [];
    const signals: Signal[] = [];

    for (const property of data.search!.properties) {
      const { totals, previous } = property;
      const start = dayOf(property.startDate);
      const end = new Date(dayOf(property.endDate).getTime() + DAY_MS);
      const fingerprint = `searchCtrGap:${property.siteId}`;
      const ctrNow = round1(totals.ctr * 100);
      readings.push({ fingerprint, metric: "ctr", value: ctrNow, periodStart: start, periodEnd: end });
      if (!previous || previous.impressions < MIN_PREVIOUS_IMPRESSIONS || previous.ctr <= 0) continue;

      const ctrBefore = round1(previous.ctr * 100);
      const impressionChange = changePct(totals.impressions, previous.impressions) ?? 0;
      const ctrDrop = Math.round(((previous.ctr - totals.ctr) / previous.ctr) * 100);
      if (impressionChange < MIN_IMPRESSION_RISE || ctrDrop < threshold) continue;

      const expected = Math.round(totals.impressions * previous.ctr);
      const missed = Math.max(0, expected - totals.clicks);
      const label = property.propertyUrl.replace(/^sc-domain:/, "");
      const factors: Factors = {
        impact: {
          level: levelAtLeast(missed, 100, 20),
          reason: `At the earlier click-through rate these impressions would bring about ${fmt(expected)} clicks, and they brought ${fmt(totals.clicks)}.`,
        },
        confidence:
          previous.impressions >= 10000
            ? { level: "high", reason: "Both periods have a large number of impressions." }
            : previous.impressions >= 3000
              ? { level: "medium", reason: "Enough impressions to compare." }
              : { level: "low", reason: "Impressions are modest, so this could be chance." },
        urgency:
          ctrDrop >= threshold * 2
            ? { level: "medium", reason: "A large shift over four weeks." }
            : { level: "low", reason: "Built up over four weeks rather than overnight." },
        effort: { level: "low", reason: "Usually titles and descriptions on the pages that gained impressions." },
      };

      signals.push({
        detector: "searchCtrGap",
        fingerprint,
        category: "search_visibility",
        entity: { type: "searchProperty", key: property.siteId, label },
        title: "More Google impressions, but fewer clicks per search",
        summary: `Impressions rose ${impressionChange}% to ${fmt(totals.impressions)} over 28 days, while click-through fell from ${pctText(ctrBefore)} to ${pctText(ctrNow)}.`,
        whyItMatters:
          "You are showing up in more searches, but a smaller share of searchers click. Some of that is normal when you start appearing for broader searches. The rest is clicks a better title or description could win.",
        nextSteps: [
          "Open Search visibility and sort pages by impressions to see which ones gained the most.",
          "Check the title and description Google shows for those pages, and whether they match what people searched for.",
          "Look at average position. If it dropped, the issue is ranking rather than the snippet.",
          "Rewrite the title and description on one or two pages first, then compare again in four weeks.",
        ],
        limitations: [
          "Google reports search data with a delay of two to three days.",
          "Click-through often falls when you start appearing for broader or lower-ranked searches. That can be healthy.",
          "This looks at the whole property, not single pages.",
        ],
        metrics: [
          { key: "impressions", label: "Impressions", current: totals.impressions, previous: previous.impressions, unit: "count" },
          { key: "clicks", label: "Clicks", current: totals.clicks, previous: previous.clicks, unit: "count" },
          { key: "ctr", label: "Click-through rate", current: ctrNow, previous: ctrBefore, unit: "percent" },
          { key: "position", label: "Average position", current: round1(totals.position), previous: round1(previous.position), unit: "count" },
        ],
        primaryMetric: "ctr",
        period: {
          start,
          end,
          previousStart: new Date(start.getTime() - SEARCH_DAYS * DAY_MS),
          previousEnd: start,
          days: SEARCH_DAYS,
          includesToday: false,
        },
        sampleSize: totals.impressions,
        sources: ["searchConsole"],
        factors,
      });
    }

    return { signals, readings };
  },
};
