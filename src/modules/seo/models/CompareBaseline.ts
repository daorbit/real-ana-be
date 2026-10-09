import mongoose, { Schema } from "mongoose";

const historyPointSchema = new Schema(
  {
    score: { type: Number, required: true },
    wordCount: { type: Number, default: 0 },
    responseTimeMs: { type: Number, default: 0 },
    statusCode: { type: Number, default: 200 },
    takenAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const compareBaselineSchema = new Schema(
  {
    siteId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    snapshot: { type: Schema.Types.Mixed, default: null },
    checkedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
    history: { type: [historyPointSchema], default: [] },
  },
  { timestamps: true }
);

export const CompareBaseline = mongoose.model("CompareBaseline", compareBaselineSchema);
