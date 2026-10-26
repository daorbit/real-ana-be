import mongoose, { Schema, InferSchemaType } from "mongoose";

export const PROVIDERS = ["linkedin", "instagram"] as const;
export type Provider = (typeof PROVIDERS)[number];

const socialConnectionSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: { type: String, enum: PROVIDERS, required: true },
    providerUserId: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    picture: { type: String, trim: true, default: "" },
    accessToken: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    scope: { type: String, default: "" },
  },
  { timestamps: true }
);

socialConnectionSchema.index({ workspaceId: 1, provider: 1 }, { unique: true });
socialConnectionSchema.index({ provider: 1, providerUserId: 1 });

export type SocialConnectionDoc = InferSchemaType<typeof socialConnectionSchema>;
export const SocialConnection = mongoose.model("SocialConnection", socialConnectionSchema);
