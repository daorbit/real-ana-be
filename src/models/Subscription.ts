import mongoose, { Schema } from "mongoose";

/**
 * One user's billing state: which plan they're on, the Razorpay subscription
 * behind it, and how much of this cycle's audit/crawl quota is left.
 *
 * One per user rather than per workspace — plans are sold to the account, not
 * to an individual site or workspace, matching how Workspace itself hangs off
 * `userId`.
 */
export const SUBSCRIPTION_STATUSES = [
  "created", // Razorpay subscription created, first charge not yet confirmed
  "active",
  "past_due", // a renewal charge failed but Razorpay is still retrying
  "cancelled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_CYCLES = ["monthly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
    cycle: { type: String, enum: BILLING_CYCLES, required: true },

    razorpaySubscriptionId: { type: String, default: "" },
    razorpayCustomerId: { type: String, default: "" },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: "created" },

    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },

    /**
     * Quota usage for the *current* billing cycle only. Reset to 0 on every
     * renewal (see the webhook handler) — unused plan quota does not roll over,
     * only purchased addon credits do.
     */
    auditsUsed: { type: Number, default: 0 },
    crawlsUsed: { type: Number, default: 0 },

    /**
     * Addon credits bought on top of the plan. These persist across renewals
     * and are drawn down only after the plan's own quota for the cycle is
     * exhausted — see `lib/quota.ts`.
     */
    addonAuditCredits: { type: Number, default: 0 },
    addonCrawlCredits: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
