import mongoose, { Schema } from "mongoose";

export const CAMPAIGN_STATUSES = ["draft", "preparing", "sending", "paused", "sent"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

const campaignSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    name: { type: String, required: true, trim: true },
    subject: { type: String, default: "" },
    body: { type: String, default: "" },
    ctaLabel: { type: String, default: "" },
    ctaUrl: { type: String, default: "" },
    senderAddress: { type: String, default: "" },
    formIds: { type: [String], default: [] },
    imported: {
      type: [{ email: { type: String, required: true }, name: { type: String, default: "" }, _id: false }],
      default: [],
    },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: "draft" },
    counts: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      unsubscribed: { type: Number, default: 0 },
    },
    lastError: { type: String, default: "" },
    consentConfirmedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

campaignSchema.index({ workspaceId: 1, createdAt: -1 });
campaignSchema.index({ status: 1, startedAt: 1 });

export const Campaign = mongoose.model("Campaign", campaignSchema);
