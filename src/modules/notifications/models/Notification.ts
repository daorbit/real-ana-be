import mongoose, { Schema } from "mongoose";
import { NOTIFICATION_TYPES } from "../types.js";


const notificationSchema = new Schema(
  {
    /** The recipient. Every query in the product starts here. */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },

    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    data: { type: Schema.Types.Mixed, default: {} },

    link: { type: String, default: "" },

    /**
     * Who caused it, when a person did. Renders the avatar on the row, and is
     * excluded from fan-out — nobody needs telling about their own actions.
     */
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    seenAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);


notificationSchema.index({ userId: 1, createdAt: -1 });

notificationSchema.index(
  { userId: 1, seenAt: 1 },
  { partialFilterExpression: { seenAt: null } }
);


notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const Notification = mongoose.model("Notification", notificationSchema);
