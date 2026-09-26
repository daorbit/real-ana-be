import mongoose, { Schema, InferSchemaType } from "mongoose";
import { CONNECTION_STATUS } from "../../reviews/models/GoogleConnection.js";

const searchConsoleConnectionSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },

    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    googleUserId: { type: String, default: "", trim: true },
    googleEmail: { type: String, trim: true, lowercase: true, default: "" },

    accessToken: { type: String, required: true, select: false },
    refreshToken: { type: String, default: "", select: false },

    expiresAt: { type: Date, required: true },
    scope: { type: String, default: "" },

    status: { type: String, enum: CONNECTION_STATUS, default: "active", index: true },
    statusMessage: { type: String, default: "" },
  },
  { timestamps: true },
);

searchConsoleConnectionSchema.index({ workspaceId: 1 }, { unique: true });

export type SearchConsoleConnectionDoc = InferSchemaType<typeof searchConsoleConnectionSchema>;
export const SearchConsoleConnection = mongoose.model(
  "SearchConsoleConnection",
  searchConsoleConnectionSchema,
);
