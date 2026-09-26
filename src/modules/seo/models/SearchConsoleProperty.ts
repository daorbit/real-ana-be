import mongoose, { Schema, InferSchemaType } from "mongoose";

const searchConsolePropertySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, unique: true },
    propertyUrl: { type: String, required: true, trim: true },
    permissionLevel: { type: String, default: "" },
    linkedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type SearchConsolePropertyDoc = InferSchemaType<typeof searchConsolePropertySchema>;
export const SearchConsoleProperty = mongoose.model(
  "SearchConsoleProperty",
  searchConsolePropertySchema,
);
