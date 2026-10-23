import mongoose, { Schema } from "mongoose";
import { CURRENCIES } from "../currency.js";

const priceFields = Object.fromEntries(
  CURRENCIES.map((c) => [c, { type: Number, required: true, min: 0, default: 0 }]),
);

const appPriceSchema = new Schema(
  {
    appId: { type: String, required: true, unique: true, trim: true },
    price: { type: new Schema(priceFields, { _id: false }), default: () => ({}) },
  },
  { timestamps: true },
);

export const AppPrice = mongoose.model("AppPrice", appPriceSchema);
