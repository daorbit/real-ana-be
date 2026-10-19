import mongoose, { Schema } from "mongoose";

const oauthGrantSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    clientId: { type: String, required: true },
    clientName: { type: String, required: true },
    scopes: { type: [String], required: true },
    resource: { type: String, required: true },
    activatedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: "" },
  },
  { timestamps: true },
);

oauthGrantSchema.index({ userId: 1, revokedAt: 1 });

export const OAuthGrant = mongoose.model("OAuthGrant", oauthGrantSchema);
