import mongoose, { Schema } from "mongoose";

const RETENTION_SECONDS = 400 * 24 * 60 * 60;

const apiKeyUsageSchema = new Schema({
  keyId: { type: Schema.Types.ObjectId, ref: "ApiKey", required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  day: { type: Date, required: true },
  requests: { type: Number, default: 0 },
  failures: { type: Number, default: 0 },
});

apiKeyUsageSchema.index({ keyId: 1, day: 1 }, { unique: true });
apiKeyUsageSchema.index({ workspaceId: 1, day: 1 });
apiKeyUsageSchema.index({ day: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const ApiKeyUsage = mongoose.model("ApiKeyUsage", apiKeyUsageSchema);
