import mongoose, { Schema } from "mongoose";

/**
 * A percent-off code, admin-created, applicable at checkout for either a plan
 * purchase or an addon pack purchase. Percent-only by design — no flat-amount
 * type — so the discount always makes sense regardless of which price it's
 * applied against.
 */
const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    percentOff: { type: Number, required: true, min: 1, max: 100 },
    active: { type: Boolean, default: true },
    /** No expiry when unset — the coupon is valid until deactivated. */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Coupon = mongoose.model("Coupon", couponSchema);
