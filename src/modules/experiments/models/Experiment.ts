import mongoose, { Schema } from "mongoose";

export const EXPERIMENT_TYPES = ["split", "changes", "code"] as const;
export const EXPERIMENT_STATUSES = ["draft", "running", "paused", "ended"] as const;
export const CHANGE_ACTIONS = ["text", "hide", "attr", "style"] as const;
export const EXPERIMENT_DEVICES = ["all", "desktop", "mobile"] as const;
export const EXPERIMENT_PAGE_MODES = ["all", "include", "exclude"] as const;
export const GOAL_TYPES = ["page", "event"] as const;

export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

const changeSchema = new Schema(
  {
    selector: { type: String, required: true },
    action: { type: String, enum: CHANGE_ACTIONS, required: true },
    attr: { type: String, default: "" },
    value: { type: String, default: "" },
  },
  { _id: false },
);

const variantSchema = new Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    weight: { type: Number, default: 50 },
    redirectUrl: { type: String, default: "" },
    changes: { type: [changeSchema], default: [] },
  },
  { _id: false },
);

const experimentSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    siteId: { type: String, required: true },
    name: { type: String, required: true },
    key: { type: String, required: true },
    type: { type: String, enum: EXPERIMENT_TYPES, required: true },
    status: { type: String, enum: EXPERIMENT_STATUSES, default: "draft" },
    pages: {
      mode: { type: String, enum: EXPERIMENT_PAGE_MODES, default: "all" },
      patterns: { type: [String], default: [] },
    },
    devices: { type: String, enum: EXPERIMENT_DEVICES, default: "all" },
    goal: {
      type: { type: String, enum: GOAL_TYPES, default: "page" },
      value: { type: String, default: "" },
    },
    variants: { type: [variantSchema], default: [] },
    winner: { type: String, default: "" },
    keepWinner: { type: Boolean, default: false },
    startedAt: { type: Date },
    endedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

experimentSchema.index({ siteId: 1, status: 1 });
experimentSchema.index({ workspaceId: 1, createdAt: -1 });
experimentSchema.index({ siteId: 1, key: 1 }, { unique: true });

export const Experiment = mongoose.model("Experiment", experimentSchema);
