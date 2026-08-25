import mongoose, { Schema } from "mongoose";

/**
 * A saved funnel definition for a workspace — an ordered list of page/event
 * steps a user names and reuses, distinct from an ad-hoc computed funnel
 * (which is never persisted, see POST /:wid/funnel).
 */
const funnelSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true },
    steps: {
      type: [
        {
          type: { type: String, enum: ["page", "event"], required: true },
          value: { type: String, required: true },
          _id: false,
        },
      ],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length >= 2 && v.length <= 8,
        message: "steps must have between 2 and 8 entries",
      },
    },
  },
  { timestamps: true }
);

export const Funnel = mongoose.model("Funnel", funnelSchema);
