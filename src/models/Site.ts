import mongoose, { Schema } from "mongoose";

const siteSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true }, // optional (platform sites)
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true }, // optional (platform sites have no dashboard user)
    name: { type: String, required: true },
    domain: { type: String, required: true },
    framework: { type: String, default: "other" }, // react | vue | angular | svelte | other
    siteId: { type: String, required: true, unique: true, index: true }, // public tracking key
  },
  { timestamps: true }
);

export const Site = mongoose.model("Site", siteSchema);
