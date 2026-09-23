import mongoose, { Schema } from "mongoose";


const heatmapClickSchema = new Schema({
  siteId: { type: String, required: true, index: true },
  type: { type: String, enum: ["click", "scroll"], required: true },
  path: { type: String, required: true, default: "/" },

  xPct: { type: Number, default: 0 }, // 0-100
  yPct: { type: Number, default: 0 }, // 0-100, from page top

  scrollPct: { type: Number, default: 0 }, // 0-100

  device: { type: String, default: "unknown" }, // desktop | mobile | tablet
  viewportW: { type: Number, default: 0 },
  viewportH: { type: Number, default: 0 },

  sessionId: { type: String, default: "" },
  ts: { type: Date, default: Date.now, index: true },
});

heatmapClickSchema.index({ siteId: 1, path: 1, type: 1, ts: -1 });

export const HeatmapClick = mongoose.model("HeatmapClick", heatmapClickSchema);
