import mongoose, { Schema } from "mongoose";

const oauthAuthRequestSchema = new Schema(
  {
    requestHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    state: { type: String, default: "" },
    scopes: { type: [String], required: true },
    resource: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oauthAuthRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthAuthRequest = mongoose.model("OAuthAuthRequest", oauthAuthRequestSchema);
