import mongoose, { Schema } from "mongoose";

/**
 * One workspace's billing state: which plan it's on, when the current paid
 * period ends, and how much of this cycle's audit/crawl quota is left.
 *
 * No Razorpay subscription id — plans are bought via a one-time Order per
 * billing cycle, not an auto-recurring Razorpay Subscription. Renewal is the
 * user buying again; nothing here auto-charges. `status` therefore only
 * tracks whether the account currently has access, not a payment-provider
 * lifecycle — see `lib/quota.ts` for how `currentPeriodEnd` decides that.
 *
 * One per workspace, not per account: a workspace is the unit that is sold, so
 * an account running three workspaces pays three times and each carries its own
 * plan, period, and quota. `userId` is kept alongside for ownership queries
 * (admin listings, "all my subscriptions") but is deliberately not unique.
 */
export const SUBSCRIPTION_STATUSES = ["active", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_CYCLES = ["monthly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const subscriptionSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
    },
    /** The workspace's owner. Denormalised so admin views can list an account's plans without a join. */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Joins to the fixed catalogue in `src/plans.ts`, not a `Plan` document id. */
    planSlug: { type: String, required: true },
    /**
     * Joins to the Orbit catalogue in `src/orbit-plans.ts`.
     *
     * A second, independent axis: a workspace's analytics tier and its AI tier
     * are separate purchases, because they serve different appetites — a small
     * site can be a heavy Orbit user, and vice versa. Rows written before Orbit
     * plans existed have no value here, which `resolveOrbitPlan` reads as Free.
     */
    orbitPlanSlug: { type: String, default: null },
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
     * Analytics events ingested this cycle.
     *
     * Unlike every other counter here, this one is not incremented once per
     * unit at the moment it is spent: events arrive thousands at a time from
     * anonymous browsers, and a conditional write per event would double the
     * cost of the hottest path in the product. `collect` batches increments in
     * memory and flushes them, so this trails real usage slightly by design —
     * see `modules/billing/event-quota.ts`.
     */
    eventsUsed: { type: Number, default: 0 },
    /**
     * Orbit questions spent this cycle.
     *
     * Incremented only once a model has actually answered — a timeout, a
     * refusal, or an exhausted fallback chain costs the user nothing, because
     * charging for a question we failed to answer is the fastest way to make
     * someone stop asking.
     */
    orbitUsed: { type: Number, default: 0 },
    /**
     * Form submissions accepted this cycle.
     *
     * Counted past the plan's allowance rather than stopping at it: the quota
     * is soft (submissions over the line are stored and flagged, not refused),
     * so this doubles as the "how far over are they" figure the upgrade banner
     * shows.
     */
    submissionsUsed: { type: Number, default: 0 },

    /**
     * When the Orbit period ends, tracked separately from the analytics one.
     *
     * The two tiers are bought independently, so they expire independently: a
     * lapsed analytics plan must not take a paid Orbit tier down with it. Null
     * means the workspace has never bought a paid Orbit tier and is on Free,
     * which does not expire.
     */
    orbitPeriodEnd: { type: Date, default: null },

    /**
     * Addon credits bought on top of the plan. These persist across renewals
     * and are drawn down only after the plan's own quota for the cycle is
     * exhausted — see `lib/quota.ts`.
     */
    addonAuditCredits: { type: Number, default: 0 },
    addonCrawlCredits: { type: Number, default: 0 },
    /** Extra Orbit questions bought as a pack. Same rules: no expiry, spent last. */
    addonOrbitCredits: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
