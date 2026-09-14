import mongoose, { Schema, InferSchemaType } from "mongoose";

 

const googleReviewSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    googleLocationId: {
      type: Schema.Types.ObjectId,
      ref: "GoogleLocation",
      required: true,
      index: true,
    },

 
    googleReviewId: { type: String, required: true, trim: true },

    reviewerName: { type: String, trim: true, default: "A Google user" },
 
    reviewerPhoto: { type: String, trim: true, default: "" },

    /** 1–5. Zero means Google sent a star value this code does not recognise. */
    rating: { type: Number, required: true, min: 0, max: 5 },

    /** Empty for a star-only rating, which is a normal kind of review. */
    comment: { type: String, default: "" },
 
    reviewCreatedAt: { type: Date, index: true },
    reviewUpdatedAt: { type: Date },

    /** The business owner's public reply, when there is one. */
    replyComment: { type: String, default: "" },
    replyUpdatedAt: { type: Date },

 
    raw: { type: Schema.Types.Mixed },

 
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
 
googleReviewSchema.index(
  { workspaceId: 1, googleReviewId: 1 },
  { unique: true },
);

/** The list read: one location's live reviews, newest first. */
googleReviewSchema.index({ googleLocationId: 1, deletedAt: 1, reviewCreatedAt: -1 });

export type GoogleReviewDoc = InferSchemaType<typeof googleReviewSchema>;
export const GoogleReview = mongoose.model("GoogleReview", googleReviewSchema);
