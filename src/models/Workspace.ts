import mongoose, { Schema, Types } from "mongoose";

/**
 * A widget placed on the home grid. Array order is the on-screen order, so
 * position needs no field of its own.
 */
const placedSchema = new Schema(
  {
    id: { type: String, required: true },
    span: { type: Number, required: true, enum: [1, 2, 3, 4] },
  },
  { _id: false }
);

const workspaceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    /**
     * Undefined means "never customised" — the client falls back to its own
     * defaults. An empty array is a real choice (the user removed every widget)
     * and must survive a reload, so the two cannot be collapsed into one.
     */
    homeLayout: { type: [placedSchema], default: undefined },
  },
  { timestamps: true }
);

export const Workspace = mongoose.model("Workspace", workspaceSchema);
