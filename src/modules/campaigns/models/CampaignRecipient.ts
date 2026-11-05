import mongoose, { Schema } from "mongoose";

const campaignRecipientSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    email: { type: String, required: true },
    name: { type: String, default: "" },
    status: { type: String, enum: ["pending", "sending", "sent", "failed", "skipped"], default: "pending" },
    claim: { type: String },
    claimedAt: { type: Date },
    sentAt: { type: Date },
    error: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

campaignRecipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });
campaignRecipientSchema.index({ campaignId: 1, status: 1 });
campaignRecipientSchema.index({ workspaceId: 1, createdAt: -1 });
campaignRecipientSchema.index({ workspaceId: 1, email: 1, status: 1 });
campaignRecipientSchema.index({ claim: 1 }, { sparse: true });
campaignRecipientSchema.index({ status: 1, claimedAt: 1 });

export const CampaignRecipient = mongoose.model("CampaignRecipient", campaignRecipientSchema);
