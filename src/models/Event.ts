import mongoose, { Schema } from "mongoose";

const eventSchema = new Schema({
  siteId: { type: String, required: true, index: true },
  // pageview | engagement | click | impression | custom
  type: { type: String, default: "pageview" },
  name: { type: String }, // custom event name
  path: { type: String, default: "/" },
  referrer: { type: String, default: "" },

  // click tracking (only on type: "click")
  clickText: { type: String, default: "" }, // visible label of the element
  clickTag: { type: String, default: "" }, // button | a | …
  clickId: { type: String, default: "" }, // id or data-va-cta attribute
  clickHref: { type: String, default: "" }, // destination, for links

  // impressions (only on type: "impression") — an element marked with
  // data-va-impression scrolled into view. Shares the click label so the two
  // can be joined into a click-through rate.
  impressionId: { type: String, default: "" },

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
