import mongoose, { Schema } from "mongoose";
import { CURRENCIES } from "../currency.js";

/**
 * A one-time-purchase credit pack: extra audits or crawls bought on top of a
 * plan's monthly quota. Bought via Razorpay Orders (not Subscriptions) — this
 * is a single charge, not a recurring one, so credits don't reset or expire on
 * their own; they're drawn down as they're used.
 */
export const ADDON_TYPES = ["audit", "crawl", "orbit"] as const;
export type AddonType = (typeof ADDON_TYPES)[number];

const priceFields = Object.fromEntries(
  CURRENCIES.map((c) => [c, { type: Number, required: true, min: 0, default: 0 }])
);

const addonPackSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    type: { type: String, enum: ADDON_TYPES, required: true },
    quantity: { type: Number, required: true, min: 1 },
    /** Amount in the smallest unit of each currency (paise/cents). */
    price: { type: new Schema(priceFields, { _id: false }), default: () => ({}) },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const AddonPack = mongoose.model("AddonPack", addonPackSchema);
