import mongoose, { Schema } from "mongoose";
import { NOTIFICATION_TYPES } from "../types.js";


const notificationPrefSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    inApp: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
  },
  { timestamps: true }
);

notificationPrefSchema.index({ userId: 1, type: 1 }, { unique: true });

export const NotificationPref = mongoose.model("NotificationPref", notificationPrefSchema);
