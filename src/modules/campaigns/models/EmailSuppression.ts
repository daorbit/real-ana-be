import mongoose, { Schema } from "mongoose";

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

const emailSuppressionSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    email: { type: String, required: true },
    reason: { type: String, enum: SUPPRESSION_REASONS, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

emailSuppressionSchema.index({ workspaceId: 1, email: 1 }, { unique: true });

export const EmailSuppression = mongoose.model("EmailSuppression", emailSuppressionSchema);
