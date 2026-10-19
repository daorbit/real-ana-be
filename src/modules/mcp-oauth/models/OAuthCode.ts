import mongoose, { Schema } from "mongoose";

const oauthCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    grantId: { type: Schema.Types.ObjectId, ref: "OAuthGrant", required: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oauthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthCode = mongoose.model("OAuthCode", oauthCodeSchema);
