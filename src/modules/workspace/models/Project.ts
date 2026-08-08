import mongoose, { Schema } from "mongoose";

const projectSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    extUserId: { type: String, index: true }, // org's own id for their end-user
    name: { type: String, required: true },
  },
  { timestamps: true }
);

projectSchema.index({ workspaceId: 1, extUserId: 1 });

export const Project = mongoose.model("Project", projectSchema);
