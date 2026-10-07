import mongoose, { Schema } from "mongoose";

const referralCodeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const ReferralCode = mongoose.model("ReferralCode", referralCodeSchema);
