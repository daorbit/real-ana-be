import mongoose, { Schema } from "mongoose";

const oauthTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["access", "refresh"], required: true },
    grantId: { type: Schema.Types.ObjectId, ref: "OAuthGrant", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    clientId: { type: String, required: true },
    scopes: { type: [String], required: true },
    resource: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oauthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthToken = mongoose.model("OAuthToken", oauthTokenSchema);
