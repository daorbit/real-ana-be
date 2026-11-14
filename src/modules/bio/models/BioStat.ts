import mongoose, { Schema } from "mongoose";

const RETENTION_DAYS = 400;

const counter = { type: Map, of: Number, default: {} };

const bioStatSchema = new Schema({
  pageId: { type: Schema.Types.ObjectId, ref: "BioPage", required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  day: { type: String, required: true },
  views: { type: Number, default: 0 },
  visitors: { type: Number, default: 0 },
  clicks: counter,
  sources: counter,
  referrers: counter,
  campaigns: counter,
  countries: counter,
  cities: counter,
  devices: counter,
  browsers: counter,
  os: counter,
  languages: counter,
  hours: counter,
  expiresAt: { type: Date, required: true },
});

bioStatSchema.index({ pageId: 1, day: 1 }, { unique: true });
bioStatSchema.index({ workspaceId: 1, day: 1 });
bioStatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BIO_STAT_RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const BIO_COUNTER_FIELDS = [
  "sources",
  "referrers",
  "campaigns",
  "countries",
  "cities",
  "devices",
  "browsers",
  "os",
  "languages",
] as const;

export type BioCounterField = (typeof BIO_COUNTER_FIELDS)[number];

export const BioStat = mongoose.model("BioStat", bioStatSchema);
