import mongoose, { Schema } from "mongoose";

const statsCacheSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    payload: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

statsCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StatsCache = mongoose.model("StatsCache", statsCacheSchema);
