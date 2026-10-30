import mongoose, { Schema } from "mongoose";

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const LABEL_COLORS = ["blue", "green", "amber", "red", "violet", "pink", "teal", "gray"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

const labelSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 24 },
    color: { type: String, enum: LABEL_COLORS, default: "gray" },
  },
  { _id: false },
);

const checkItemSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true, maxlength: 200 },
    done: { type: Boolean, default: false },
  },
  { _id: false },
);

const taskSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    key: { type: Number, default: 0 },
    bucketId: { type: Schema.Types.ObjectId, ref: "TaskBucket", default: null },
    title: { type: String, required: true, maxlength: 200 },
    notes: { type: String, default: "", maxlength: 4000 },
    status: { type: String, enum: TASK_STATUSES, default: "todo" },
    priority: { type: String, enum: TASK_PRIORITIES, default: "none" },
    assigneeId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dueDate: { type: Date, default: null },
    order: { type: Number, default: 0 },
    link: { type: String, default: "", maxlength: 500 },
    labels: { type: [labelSchema], default: [] },
    checklist: { type: [checkItemSchema], default: [] },
    checklistOnCard: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

taskSchema.index({ workspaceId: 1, status: 1, order: 1 });
taskSchema.index({ workspaceId: 1, assigneeId: 1, status: 1 });

export const Task = mongoose.model("Task", taskSchema);
