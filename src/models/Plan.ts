import mongoose, { Schema } from "mongoose";

/**
 * A subscription tier, editable by an admin at runtime rather than hardcoded —
 * pricing and quotas change more often than a deploy cycle should gate on.
 *
 * Each plan carries its own Razorpay Plan ids (one per billing cycle), because
 * Razorpay subscriptions are created against a specific plan id and monthly vs
 * yearly are genuinely different Razorpay plans, not one plan billed twice.
 */
const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, default: "", trim: true },

    /** Amount in paise (INR smallest unit), matching Razorpay's own unit. */
    priceMonthly: { type: Number, required: true, min: 0 },
    priceYearly: { type: Number, required: true, min: 0 },

    /** Razorpay Plan ids this tier maps to — created once in the Razorpay dashboard/API. */
    razorpayPlanIdMonthly: { type: String, default: "" },
    razorpayPlanIdYearly: { type: String, default: "" },

    maxWorkspaces: { type: Number, required: true, min: 1 },
    /** Sites allowed per workspace, not a total across the account. */
    maxSitesPerWorkspace: { type: Number, required: true, min: 1 },
    /** Audits/crawls included per billing cycle. Extra usage needs an addon pack. */
    monthlyAuditQuota: { type: Number, required: true, min: 0 },
    monthlyCrawlQuota: { type: Number, required: true, min: 0 },

    features: { type: [String], default: [] },

    active: { type: Boolean, default: true },
    /** Display order on the pricing page; lower first. */
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Plan = mongoose.model("Plan", planSchema);
