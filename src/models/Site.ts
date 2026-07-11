import mongoose, { Schema } from "mongoose";

const siteSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    domain: { type: String, required: true },
    framework: { type: String, default: "other" }, // react | vue | angular | svelte | other
    siteId: { type: String, required: true, unique: true, index: true }, // public tracking key
  },
  { timestamps: true }
);

export const Site = mongoose.model("Site", siteSchema);
