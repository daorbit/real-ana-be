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
    /**
     * The tracker options chosen when the snippet was built.
     *
     * These are NOT enforced here — the tracker reads them as `data-*`
     * attributes from its own script tag on the customer's site. They are
     * stored so the dashboard can rebuild the exact snippet later instead of
     * asking the user to remember what they picked.
     */
    trackerOptions: {
      dnt: { type: Boolean, default: false },
      hash: { type: Boolean, default: false },
      clicks: { type: Boolean, default: true },
      errors: { type: Boolean, default: true },
      ignorePages: { type: [String], default: [] },
      allowParams: { type: [String], default: [] },
      domain: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

export const Site = mongoose.model("Site", siteSchema);
