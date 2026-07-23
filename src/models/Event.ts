import mongoose, { Schema } from "mongoose";

const eventSchema = new Schema({
  siteId: { type: String, required: true, index: true },
  // pageview | engagement | click | custom
  type: { type: String, default: "pageview" },
  name: { type: String }, // custom event name
  path: { type: String, default: "/" },
  /**
   * Reported hostname, set only when the site overrides it via `data-domain`
   * (staging deploys folding into production's numbers). Empty means "the
   * host the script was served from", which is the normal case.
   */
  hostname: { type: String, default: "" },
  referrer: { type: String, default: "" },

  // click tracking (only on type: "click")
  clickText: { type: String, default: "" }, // visible label of the element
  clickTag: { type: String, default: "" }, // button | a | …
  clickId: { type: String, default: "" }, // id or data-va-cta attribute
  clickHref: { type: String, default: "" }, // destination, for links
  visitorHash: { type: String, index: true }, // anonymous, rotates daily
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

  /**
   * Core Web Vitals as the visitor's own browser measured them (tracker v5+).
   *
   * Field data, not lab data: Lighthouse simulates a load on synthetic
   * hardware, while these are what real devices experienced — and Google ranks
   * on the latter. Reported on the engagement record because several are only
   * final once the page is left. Null where the browser does not support the
   * metric; Safari, for instance, has no INP.
   */
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
  },
  props: { type: Schema.Types.Mixed }, // custom event properties

  ts: { type: Date, default: Date.now, index: true },
});

// Common range queries per site
eventSchema.index({ siteId: 1, ts: -1 });
eventSchema.index({ siteId: 1, type: 1, ts: -1 });

export const Event = mongoose.model("Event", eventSchema);
