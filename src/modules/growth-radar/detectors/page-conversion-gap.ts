import { levelAtLeast } from "../priority.js";
import type { Factors, Reading, Signal } from "../types.js";
import { fmt, normaliseHost, normalisePath, pctText, ratePct } from "./format.js";
import type { DetectorSpec } from "./spec.js";

const MIN_LEADS = 10;
const MIN_COVERAGE = 0.6;
const MIN_PAGE_SESSIONS = 150;
const MIN_EXPECTED_LEADS = 3;
const MAX_PAGES = 3;

export const pageConversionGap: DetectorSpec = {
  id: "pageConversionGap",
  version: 1,
  category: "conversion_gap",
  requires: ["analytics", "leadCapture"],
  threshold: { default: 50, min: 20, max: 90, step: 5 },
  run(data, threshold) {
    const analytics = data.analytics!;
    const forms = data.forms!;
    if (!forms.leadPages) return { skipped: "Leads by landing page could not be read." };

    const { reply, window } = forms.leadPages;
    if (reply.total < MIN_LEADS) return { skipped: `Needs at least ${MIN_LEADS} leads in the last 28 days.` };
    if (reply.withLanding / reply.total < MIN_COVERAGE) return { skipped: "Too few leads record the page they came from." };

    const hosts = new Set(analytics.sites.map((s) => normaliseHost(s.domain)).filter(Boolean));
    const leadsByPath = new Map<string, number>();
    for (const page of reply.pages) {
      if (hosts.size && !hosts.has(normaliseHost(page.host))) continue;
      const path = normalisePath(page.path);
      leadsByPath.set(path, (leadsByPath.get(path) ?? 0) + page.leads);
    }

    const matchedLeads = [...leadsByPath.values()].reduce((sum, n) => sum + n, 0);
    const totalSessions = analytics.entryPages.totalSessions;
    if (!totalSessions || !matchedLeads) return { skipped: "No leads matched a page on your tracked site." };

    const siteRate = matchedLeads / totalSessions;
    const sessionsByPath = new Map<string, number>();
    for (const row of analytics.entryPages.rows) {
      if (row.key === "(none)") continue;
      const path = normalisePath(row.key);
      sessionsByPath.set(path, (sessionsByPath.get(path) ?? 0) + row.count);
    }

    const readings: Reading[] = [];
    const flagged: { path: string; sessions: number; leads: number; expected: number }[] = [];
    for (const [path, sessions] of sessionsByPath) {
      if (sessions < MIN_PAGE_SESSIONS) continue;
      const leads = leadsByPath.get(path) ?? 0;
      readings.push({
        fingerprint: `pageConversionGap:${path}`,
        metric: "pageRate",
        value: ratePct(leads, sessions),
        periodStart: window.since,
        periodEnd: window.until,
      });
      const expected = sessions * siteRate;
      if (expected < MIN_EXPECTED_LEADS) continue;
      if (leads / sessions > siteRate * (1 - threshold / 100)) continue;
      flagged.push({ path, sessions, leads, expected });
    }

    const signals = flagged
      .sort((a, b) => b.expected - b.leads - (a.expected - a.leads))
      .slice(0, MAX_PAGES)
      .map((page): Signal => {
        const missed = Math.round(page.expected - page.leads);
        const share = Math.round((page.sessions / totalSessions) * 100);
        const pageRate = ratePct(page.leads, page.sessions);
        const averageRate = Math.round(siteRate * 1000) / 10;
        const factors: Factors = {
          impact: {
            level: missed >= 15 || share >= 15 ? "high" : levelAtLeast(missed, 15, 5),
            reason: `This page started ${share}% of all sessions. At the site's average rate it would bring about ${fmt(page.expected)} leads, and it brought ${fmt(page.leads)}.`,
          },
          confidence:
            page.sessions >= 1000 && matchedLeads >= 50
              ? { level: "high", reason: "The page has plenty of sessions and the site has plenty of leads to compare with." }
              : page.sessions >= 400
                ? { level: "medium", reason: "Enough sessions to compare, though lead counts are modest." }
                : { level: "low", reason: "The numbers are small, so this could be chance." },
          urgency: { level: "low", reason: "A pattern over four weeks rather than a sudden change." },
          effort: { level: "medium", reason: "Usually a page change: the call to action, form placement or content." },
        };
        return {
          detector: "pageConversionGap",
          fingerprint: `pageConversionGap:${page.path}`,
          category: "conversion_gap",
          entity: { type: "page", key: page.path, label: page.path },
          title: `${page.path} gets visits but few leads`,
          summary: `${fmt(page.sessions)} sessions started on ${page.path} in the last 28 days and ${fmt(page.leads)} leads came from it: ${pctText(pageRate)} against ${pctText(averageRate)} across your site.`,
          whyItMatters:
            "This page already gets attention. Bringing it up to your site's usual lead rate would add enquiries without needing more traffic.",
          nextSteps: [
            "Open the page and check that a form or a clear call to action is visible without scrolling, on a phone as well as a computer.",
            "Compare its traffic sources with your best-converting pages in Website analytics. Visitors who arrive for a different reason convert less.",
            "Check that the page matches what people searched for or clicked on to get there.",
            "If the page has no form, add one or link clearly to your contact page.",
          ],
          limitations: [
            `Leads are matched to the page where the visitor first landed, as recorded by the form. ${fmt(reply.total - reply.withLanding)} of ${fmt(reply.total)} leads had no landing page and are left out.`,
            "Some pages, such as blog posts, are not meant to bring enquiries directly.",
            "The site average includes every page, so a few strong pages raise it.",
          ],
          metrics: [
            { key: "sessions", label: "Sessions started here", current: page.sessions, previous: null, unit: "count" },
            { key: "leads", label: "Leads from this page", current: page.leads, previous: null, unit: "count" },
            { key: "pageRate", label: "Sessions that became a lead", current: pageRate, previous: null, unit: "percent" },
            { key: "siteRate", label: "Site average", current: averageRate, previous: null, unit: "percent" },
          ],
          primaryMetric: "pageRate",
          period: { start: window.since, end: window.until, previousStart: null, previousEnd: null, days: window.days, includesToday: false },
          sampleSize: page.sessions,
          sources: ["analytics", "leadCapture"],
          factors,
        };
      });

    return { signals, readings };
  },
};
