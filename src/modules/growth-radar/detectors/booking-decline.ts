import { levelAtLeast } from "../priority.js";
import type { Factors, Reading, Signal } from "../types.js";
import { changePct, fmt, ratePct } from "./format.js";
import type { DetectorSpec } from "./spec.js";

const MIN_PREVIOUS_BOOKINGS = 8;
const STEADY_VIEWS = 25;

export const bookingDecline: DetectorSpec = {
  id: "bookingDecline",
  version: 1,
  category: "booking_journey",
  requires: ["leadCapture", "bookings"],
  threshold: { default: 30, min: 10, max: 80, step: 5 },
  run(data, threshold) {
    const forms = data.forms!;
    const bookingForms = new Set(forms.bookingFormIds);
    const window = forms.formWindow;
    const readings: Reading[] = [];
    const signals: Signal[] = [];

    for (const row of forms.performance) {
      if (!bookingForms.has(row.id) || row.previousViews === undefined) continue;
      const fingerprint = `bookingDecline:${row.id}`;
      readings.push({ fingerprint, metric: "bookings", value: row.responses, periodStart: window.since, periodEnd: window.until });

      const previousViews = row.previousViews;
      const previousBookings = row.previousResponses ?? 0;
      if (previousBookings < MIN_PREVIOUS_BOOKINGS) continue;
      const viewChange = changePct(row.views, previousViews);
      if (viewChange === null || Math.abs(viewChange) > STEADY_VIEWS) continue;
      const bookingChange = changePct(row.responses, previousBookings) ?? 0;
      const drop = -bookingChange;
      if (drop < threshold) continue;

      const lost = previousBookings - row.responses;
      const title = row.title || "Untitled form";
      const factors: Factors = {
        impact: {
          level: levelAtLeast(lost, 10, 4),
          reason: `${fmt(lost)} fewer bookings than the 30 days before.`,
        },
        confidence:
          previousBookings >= 30
            ? { level: "high", reason: "Both periods have plenty of bookings." }
            : previousBookings >= 15
              ? { level: "medium", reason: "Enough bookings to compare, though the counts are modest." }
              : { level: "low", reason: "The numbers are small, so this could be chance." },
        urgency:
          drop >= threshold * 2
            ? { level: "high", reason: "A sharp drop over the last 30 days." }
            : { level: "medium", reason: "A steady drop over the last 30 days." },
        effort: { level: "low", reason: "Usually available times or the booking settings." },
      };

      signals.push({
        detector: "bookingDecline",
        fingerprint,
        category: "booking_journey",
        entity: { type: "bookingForm", key: row.id, label: title },
        title: `Fewer bookings through “${title}”, with steady visits`,
        summary: `${fmt(row.responses)} bookings in the last 30 days against ${fmt(previousBookings)} in the 30 days before, while the booking form was opened ${fmt(row.views)} times against ${fmt(previousViews)}.`,
        whyItMatters:
          "People are still opening the booking form, but fewer finish booking. When visits hold steady, the cause is usually inside the booking step: available times, notice rules or the form itself.",
        nextSteps: [
          "Open the form in the builder and check the weekly hours, notice period, buffers and days off.",
          "Open the form yourself and check that there are free times in the next two weeks.",
          "Check that the Google Calendar connection in Apps still works.",
          "Look at Bookings to see whether upcoming times are already full.",
        ],
        limitations: [
          "A booking is counted when the booking form is sent. Later cancellations are not taken off.",
          "Opens are times the booking form loaded, not visits to a booking page on your website.",
          "The latest period includes today so far.",
        ],
        metrics: [
          { key: "views", label: "Booking form opens", current: row.views, previous: previousViews, unit: "count" },
          { key: "bookings", label: "Bookings", current: row.responses, previous: previousBookings, unit: "count" },
          {
            key: "bookingRate",
            label: "Opens that became a booking",
            current: ratePct(row.responses, row.views),
            previous: ratePct(previousBookings, previousViews),
            unit: "percent",
          },
        ],
        primaryMetric: "bookings",
        period: {
          start: window.since,
          end: window.until,
          previousStart: window.prevSince,
          previousEnd: window.prevUntil,
          days: window.days,
          includesToday: true,
        },
        sampleSize: row.views,
        sources: ["leadCapture", "bookings"],
        factors,
      });
    }

    return { signals, readings };
  },
};
