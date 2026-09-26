import mongoose, { Schema } from "mongoose";

const searchConsoleCacheSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

searchConsoleCacheSchema.index({ siteId: 1, key: 1 }, { unique: true });
searchConsoleCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SearchConsoleCache = mongoose.model("SearchConsoleCache", searchConsoleCacheSchema);
