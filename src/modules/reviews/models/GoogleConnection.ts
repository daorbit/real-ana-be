import mongoose, { Schema, InferSchemaType } from "mongoose";

 
export const CONNECTION_STATUS = ["active", "revoked", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUS)[number];

const googleConnectionSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    /** Who authorised it. Audit only — access is decided by workspace membership. */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

 
    googleUserId: { type: String, required: true, trim: true },
    googleEmail: { type: String, trim: true, lowercase: true, default: "" },

    /** Encrypted at rest; see `crypto-box`. Never projected by default. */
    accessToken: { type: String, required: true, select: false },
 
    refreshToken: { type: String, default: "", select: false },

    /** When `accessToken` stops working. Checked before every Google call. */
    expiresAt: { type: Date, required: true },
 
    scope: { type: String, default: "" },

    status: { type: String, enum: CONNECTION_STATUS, default: "active", index: true },

 
    statusMessage: { type: String, default: "" },
  },
  { timestamps: true },
);

 
googleConnectionSchema.index({ workspaceId: 1 }, { unique: true });

export type GoogleConnectionDoc = InferSchemaType<typeof googleConnectionSchema>;
export const GoogleConnection = mongoose.model("GoogleConnection", googleConnectionSchema);
