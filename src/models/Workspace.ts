import mongoose, { Schema, Types } from "mongoose";

const workspaceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
  },
  { timestamps: true }
);

export const Workspace = mongoose.model("Workspace", workspaceSchema);
