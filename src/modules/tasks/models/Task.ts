import mongoose, { Schema } from "mongoose";

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["none", "low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const taskSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    title: { type: String, required: true, maxlength: 200 },
    notes: { type: String, default: "", maxlength: 4000 },
    status: { type: String, enum: TASK_STATUSES, default: "todo" },
    priority: { type: String, enum: TASK_PRIORITIES, default: "none" },
    assigneeId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dueDate: { type: Date, default: null },
    order: { type: Number, default: 0 },
    link: { type: String, default: "", maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

taskSchema.index({ workspaceId: 1, status: 1, order: 1 });
taskSchema.index({ workspaceId: 1, assigneeId: 1, status: 1 });

export const Task = mongoose.model("Task", taskSchema);
