import mongoose, { Schema } from "mongoose";

/**
 * The one editable thing about a plan: its price. Everything else — name,
 * quotas, workspace/site limits, Razorpay ids — lives in the fixed catalogue
 * at `src/plans.ts` and never touches the database. `slug` is the join key
 * back to that catalogue rather than a Mongo `_id`, since the catalogue entry
 * is the source of truth for identity.
 *
 * A missing row for a catalogue slug just means "no price override yet" —
 * callers fall back to the catalogue default (see `lib/planPricing.ts`).
 */
const planSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    /** Amount in paise (INR smallest unit), matching Razorpay's own unit. */
    priceMonthly: { type: Number, required: true, min: 0 },
    priceYearly: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

export const Plan = mongoose.model("Plan", planSchema);
