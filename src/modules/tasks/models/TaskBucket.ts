import mongoose, { Schema } from "mongoose";

const taskBucketSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    name: { type: String, required: true, maxlength: 40 },
    order: { type: Number, default: 0 },
    limit: { type: Number, default: null },
  },
  { timestamps: true },
);

taskBucketSchema.index({ workspaceId: 1, order: 1 });

export const TaskBucket = mongoose.model("TaskBucket", taskBucketSchema);
