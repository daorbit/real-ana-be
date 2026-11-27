import mongoose, { Schema } from "mongoose";

const platformTokenUseSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

platformTokenUseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PlatformTokenUse = mongoose.model("PlatformTokenUse", platformTokenUseSchema);
