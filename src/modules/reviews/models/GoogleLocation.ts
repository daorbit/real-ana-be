import mongoose, { Schema, InferSchemaType } from "mongoose";

 

export const LOCATION_STATUS = ["connected", "disconnected", "error"] as const;
export type LocationStatus = (typeof LOCATION_STATUS)[number];

const googleLocationSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    googleConnectionId: {
      type: Schema.Types.ObjectId,
      ref: "GoogleConnection",
      required: true,
      index: true,
    },

   
    googleAccountId: { type: String, required: true, trim: true },
    googleLocationId: { type: String, required: true, trim: true },
 
    title: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },

    status: { type: String, enum: LOCATION_STATUS, default: "connected", index: true },

 
    averageRating: { type: Number, default: 0 },
    totalReviewCount: { type: Number, default: 0 },

    lastSyncedAt: { type: Date },
    /** Our own words on why the last sync failed; never a raw Google body. */
    lastSyncError: { type: String, default: "" },
  },
  { timestamps: true },
);

 
googleLocationSchema.index(
  { workspaceId: 1, googleLocationId: 1 },
  { unique: true },
);

export type GoogleLocationDoc = InferSchemaType<typeof googleLocationSchema>;
export const GoogleLocation = mongoose.model("GoogleLocation", googleLocationSchema);
