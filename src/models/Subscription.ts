import mongoose, { Schema } from "mongoose";

/**
 * One user's billing state: which plan they're on, when the current paid
 * period ends, and how much of this cycle's audit/crawl quota is left.
 *
 * No Razorpay subscription id — plans are bought via a one-time Order per
 * billing cycle, not an auto-recurring Razorpay Subscription. Renewal is the
 * user buying again; nothing here auto-charges. `status` therefore only
 * tracks whether the account currently has access, not a payment-provider
 * lifecycle — see `lib/quota.ts` for how `currentPeriodEnd` decides that.
 *
 * One per user rather than per workspace — plans are sold to the account, not
 * to an individual site or workspace, matching how Workspace itself hangs off
 * `userId`.
 */
export const SUBSCRIPTION_STATUSES = ["active", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_CYCLES = ["monthly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    /** Joins to the fixed catalogue in `src/plans.ts`, not a `Plan` document id. */
    planSlug: { type: String, required: true },
    cycle: { type: String, enum: BILLING_CYCLES, required: true },

    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: "active" },

    currentPeriodStart: { type: Date, default: null },
    /** Free has no real expiry (see the seed script); paid plans expire one cycle after purchase. */
    currentPeriodEnd: { type: Date, default: null },

    /**
     * Quota usage for the *current* billing cycle only. Reset to 0 whenever a
     * purchase starts a new period — unused plan quota does not roll over,
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
