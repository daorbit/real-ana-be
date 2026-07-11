import mongoose, { Schema } from "mongoose";

const eventSchema = new Schema({
  siteId: { type: String, required: true, index: true },
  type: { type: String, default: "pageview" }, // pageview | custom
  name: { type: String }, // custom event name
  path: { type: String, default: "/" },
  referrer: { type: String, default: "" },
  visitorHash: { type: String, index: true }, // anonymous, rotates daily
  sessionId: { type: String, index: true },
  device: { type: String, default: "unknown" }, // desktop | mobile | tablet
  os: { type: String, default: "unknown" },
  browser: { type: String, default: "unknown" },
  country: { type: String, default: "unknown" },
  utm: {
    source: { type: String, default: "" },
    medium: { type: String, default: "" },
    campaign: { type: String, default: "" },
  },
  ts: { type: Date, default: Date.now, index: true },
});

// Compound index for common range queries per site
eventSchema.index({ siteId: 1, ts: -1 });

export const Event = mongoose.model("Event", eventSchema);
