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
    /**
     * Latest tracker version this site has reported. Scripts predating the
     * version field send nothing, so 1 is the floor rather than a real report —
     * which is exactly the case we want to prompt about.
     */
    trackerVersion: { type: Number, default: 1 },
  },
  { timestamps: true }
);

export const Site = mongoose.model("Site", siteSchema);
