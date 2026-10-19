import mongoose, { Schema } from "mongoose";

const oauthClientSchema = new Schema(
  {
    clientId: { type: String, required: true, unique: true },
    clientName: { type: String, required: true, maxlength: 100 },
    clientUri: { type: String, default: "" },
    redirectUris: { type: [String], required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const OAuthClient = mongoose.model("OAuthClient", oauthClientSchema);
