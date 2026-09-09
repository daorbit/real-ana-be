import mongoose, { Schema } from "mongoose";

/**
 * One asset in a workspace's media library.
 *
 * The file itself lives in Cloudinary; this row is the workspace's own record
 * of it — what it is called, who added it, and the handle needed to delete it.
 * Keeping that record here rather than listing Cloudinary directly is what
 * scopes the library to a workspace, and what makes renaming possible without
 * touching the stored file.
 */
const mediaSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    /** The display name, which can change without moving the file. */
    name: { type: String, required: true, trim: true },
    /** Alt text for images. Empty where it would mean nothing. */
    alt: { type: String, trim: true, default: "" },

    url: { type: String, required: true },
    /** Cloudinary's handle, needed to delete the asset. */
    publicId: { type: String, required: true },
    /** Which Cloudinary pipeline holds it — needed to address it again. */
    kind: { type: String, enum: ["image", "video", "raw"], required: true },

    mime: { type: String, required: true },
    format: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    /**
     * A delivery-time transformation of the same asset rather than a second
     * upload, so it can never drift from the original.
     */
    thumbnailUrl: { type: String, default: "" },

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// The library is browsed newest-first within one workspace, which is exactly
// what this index serves.
mediaSchema.index({ workspaceId: 1, createdAt: -1 });

export type MediaDoc = mongoose.InferSchemaType<typeof mediaSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Media = mongoose.models.Media ?? mongoose.model("Media", mediaSchema);
