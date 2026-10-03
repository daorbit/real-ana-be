import mongoose, { Schema } from "mongoose";
import { TRAFFIC_KINDS } from "../bot-detect.js";

const eventSchema = new Schema({
  siteId: { type: String, required: true, index: true },
  // pageview | engagement | click | custom
  type: { type: String, default: "pageview" },
  name: { type: String }, // custom event name
  path: { type: String, default: "/" },

  hostname: { type: String, default: "" },
  referrer: { type: String, default: "" },

  // click tracking (only on type: "click")
  clickText: { type: String, default: "" }, // visible label of the element
  clickTag: { type: String, default: "" }, // button | a | …
  clickId: { type: String, default: "" }, // id or data-va-cta attribute
  clickHref: { type: String, default: "" }, // destination, for links
  visitorHash: { type: String, index: true }, // anonymous, rotates daily

  appUserId: { type: String, default: "", index: true },
  /** Persistent per-install id from the React Native SDK, stable across logins. */
  installId: { type: String, default: "" },
  /** Where the action happened, e.g. "dashboard" — identified events only. */
  source: { type: String, default: "" },
  /** Where the action led, e.g. "widget_modal" — identified events only. */
  destination: { type: String, default: "" },
  sessionId: { type: String, index: true },

  // client context
  device: { type: String, default: "unknown" }, // desktop | mobile | tablet
  os: { type: String, default: "unknown" },
  browser: { type: String, default: "unknown" },
  country: { type: String, default: "unknown" },
  language: { type: String, default: "" },
  timezone: { type: String, default: "" },
  screenW: { type: Number, default: 0 },
  screenH: { type: Number, default: 0 },
  viewportW: { type: Number, default: 0 },
  viewportH: { type: Number, default: 0 },

  // session / funnel
  isEntry: { type: Boolean, default: false }, // first pageview of the session
  isExit: { type: Boolean, default: false }, // page the session ended on
  entryPath: { type: String, default: "" },

  // engagement (only on type: "engagement")
  durationMs: { type: Number, default: 0 }, // visible time on the page
  bounce: { type: Boolean, default: false }, // session ended with 1 pageview
  // Furthest point of the page reached, as a percentage. Reported on the
  // engagement record because it is only final once the page is left.
  scrollDepth: { type: Number, default: 0 },


  vitals: {
    /** Largest Contentful Paint, ms. Good ≤ 2500. */
    lcp: { type: Number, default: null },
    /** Cumulative Layout Shift, unitless. Good ≤ 0.1. */
    cls: { type: Number, default: null },
    /** Interaction to Next Paint, ms. Good ≤ 200. */
    inp: { type: Number, default: null },
    /** First Contentful Paint, ms. Good ≤ 1800. */
    fcp: { type: Number, default: null },
    /** Time to First Byte, ms. Good ≤ 800. */
    ttfb: { type: Number, default: null },
  },


  utm: {
    source: { type: String, default: "" },
    medium: { type: String, default: "" },
    campaign: { type: String, default: "" },
    term: { type: String, default: "" },
    content: { type: String, default: "" },

    clickId: { type: String, default: "" },
    /** Referrer of the session's landing page, kept for channel grouping. */
    landingReferrer: { type: String, default: "" },
  },
  props: { type: Schema.Types.Mixed }, // custom event properties

  traffic: {
    kind: { type: String, enum: TRAFFIC_KINDS, default: "human" },
    name: { type: String, default: "" },
    signals: { type: [String], default: undefined },
  },

  ts: { type: Date, default: Date.now, index: true },
});

// Common range queries per site
eventSchema.index({ siteId: 1, ts: -1 });
eventSchema.index({ siteId: 1, type: 1, ts: -1 });
// Per-user timeline: "everything user X did, in order" — app sites only.
eventSchema.index({ siteId: 1, appUserId: 1, ts: -1 });
// Backfill lookup during identify(): find every pre-signup event for an install.
eventSchema.index({ siteId: 1, installId: 1 });

export const Event = mongoose.model("Event", eventSchema);
