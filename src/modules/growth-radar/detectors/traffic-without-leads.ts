import { levelAtLeast } from "../priority.js";
import type { Factors, Signal } from "../types.js";
import { changePct, fmt, pctText, ratePct } from "./format.js";
import type { DetectorSpec } from "./spec.js";

const MIN_PREVIOUS_SESSIONS = 100;
const MIN_PREVIOUS_LEADS = 5;
const FINGERPRINT = "trafficWithoutLeads:workspace";

function leadTrend(change: number): string {
  if (change > 0) return `only up ${change}%`;
  if (change < 0) return `down ${Math.abs(change)}%`;
  return "flat";
}

export const trafficWithoutLeads: DetectorSpec = {
  id: "trafficWithoutLeads",
  version: 1,
  category: "traffic_without_enquiries",
  requires: ["analytics", "leadCapture"],
  threshold: { default: 20, min: 10, max: 100, step: 5 },
  run(data, threshold) {
    const analytics = data.analytics!;
    const forms = data.forms!;
    if (!forms.leadsWeek) return { skipped: "Weekly lead counts could not be read." };

    const { window } = analytics.week;
    const sessionsNow = analytics.week.current.sessions;
    const sessionsBefore = analytics.week.previous.sessions;
    const leadsNow = forms.leadsWeek.current;
    const leadsBefore = forms.leadsWeek.previous;
    const rateNow = ratePct(leadsNow, sessionsNow);
    const rateBefore = ratePct(leadsBefore, sessionsBefore);

    const readings = [{ fingerprint: FINGERPRINT, metric: "leadRate", value: rateNow, periodStart: window.since, periodEnd: window.until }];
    if (sessionsBefore < MIN_PREVIOUS_SESSIONS || leadsBefore < MIN_PREVIOUS_LEADS) return { signals: [], readings };

    const sessionChange = changePct(sessionsNow, sessionsBefore) ?? 0;
    const leadChange = changePct(leadsNow, leadsBefore) ?? 0;
    if (sessionChange < threshold || leadChange > sessionChange / 4) return { signals: [], readings };

    const expected = Math.round(sessionsNow * (leadsBefore / sessionsBefore));
    const gap = Math.max(0, expected - leadsNow);

    const factors: Factors = {
      impact: {
        level: levelAtLeast(gap, 20, 5),
        reason: `At the earlier rate about ${fmt(expected)} leads would be expected last week, and ${fmt(leadsNow)} came in.`,
      },
      confidence:
        sessionsBefore >= 1000 && leadsBefore >= 20
          ? { level: "high", reason: "Both weeks have plenty of sessions and leads." }
          : sessionsBefore >= 300 && leadsBefore >= 8
            ? { level: "medium", reason: "Enough sessions and leads to compare, though one unusual day could still move it." }
            : { level: "low", reason: "The numbers are small, so this could be chance." },
      urgency:
        sessionChange >= threshold * 2
          ? { level: "high", reason: "The gap opened in the most recent complete week." }
          : { level: "medium", reason: "Seen in the most recent complete week." },
      effort: { level: "medium", reason: "Usually means checking traffic sources, landing pages and where forms sit." },
    };

    const signal: Signal = {
      detector: "trafficWithoutLeads",
      fingerprint: FINGERPRINT,
      category: "traffic_without_enquiries",
      entity: { type: "workspace", key: "", label: analytics.sites.length === 1 ? analytics.sites[0].name : "All sites" },
      title: `Sessions up ${sessionChange}%, but leads ${leadTrend(leadChange)}`,
      summary: `${fmt(sessionsNow)} sessions last week against ${fmt(sessionsBefore)} the week before, while leads went from ${fmt(leadsBefore)} to ${fmt(leadsNow)}. Sessions that became a lead fell from ${pctText(rateBefore)} to ${pctText(rateNow)}.`,
      whyItMatters:
        "More people are reaching your site, but the extra visits are not turning into enquiries. Finding out where the new visits come from and where they land shows whether this is a different audience or a page that is not asking for the enquiry.",
      nextSteps: [
        "Open Website analytics for last week and compare traffic sources with the week before. Note which source grew the most.",
        "Check the pages new visitors land on, and whether each one shows a form or a clear call to action.",
        "Open Lead insights and check that every form still loads and accepts responses.",
        "If one new source drove the rise, decide whether that audience is a fit before changing your pages.",
      ],
      limitations: [
        "Leads are counted across every Lead capture form in the workspace, including forms shared outside your website.",
        "Enquiries by phone, email or chat are not counted.",
        "This compares two single weeks. A holiday or a one-off campaign can cause it.",
      ],
      metrics: [
        { key: "sessions", label: "Sessions", current: sessionsNow, previous: sessionsBefore, unit: "count" },
        { key: "leads", label: "Leads", current: leadsNow, previous: leadsBefore, unit: "count" },
        { key: "leadRate", label: "Sessions that became a lead", current: rateNow, previous: rateBefore, unit: "percent" },
      ],
      primaryMetric: "leadRate",
      period: {
        start: window.since,
        end: window.until,
        previousStart: window.prevSince,
        previousEnd: window.prevUntil,
        days: window.days,
        includesToday: false,
      },
      sampleSize: sessionsNow,
      sources: ["analytics", "leadCapture"],
      factors,
    };

    return { signals: [signal], readings };
  },
};
