import mongoose, { Schema } from "mongoose";
import { CURRENCIES } from "../currency.js";

/**
 * The one editable thing about a plan: its price, per currency. Everything
 * else — name, quotas, workspace/site limits, Razorpay ids — lives in the
 * fixed catalogue at `src/plans.ts` and never touches the database. `slug` is
 * the join key back to that catalogue rather than a Mongo `_id`, since the
 * catalogue entry is the source of truth for identity.
 *
 * A missing row for a catalogue slug just means "no price override yet" —
 * callers fall back to the catalogue default (see `lib/planPricing.ts`). Same
 * for a missing currency within `prices` — it falls back to 0 for that
 * currency specifically.
 */
const priceFields = Object.fromEntries(
  CURRENCIES.map((c) => [c, { type: Number, required: true, min: 0, default: 0 }])
);

const planSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    /** Amount in the smallest unit of each currency (paise/cents), matching Razorpay's own unit. */
    priceMonthly: { type: new Schema(priceFields, { _id: false }), default: () => ({}) },
    priceYearly: { type: new Schema(priceFields, { _id: false }), default: () => ({}) },
  },
  { timestamps: true }
);

export const Plan = mongoose.model("Plan", planSchema);
