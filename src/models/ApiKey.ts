import mongoose, { Schema } from "mongoose";

const apiKeySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, default: "Default key" },
    keyHash: { type: String, required: true, index: true }, // sha256 of raw key
    prefix: { type: String, required: true }, // e.g. sk_live_ab12 (for display)
    lastUsedAt: { type: Date },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const ApiKey = mongoose.model("ApiKey", apiKeySchema);
