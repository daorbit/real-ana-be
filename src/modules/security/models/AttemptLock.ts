import mongoose, { Schema } from "mongoose";

const attemptLockSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    attempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

attemptLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AttemptLock = mongoose.model("AttemptLock", attemptLockSchema);
