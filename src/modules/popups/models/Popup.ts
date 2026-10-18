import mongoose, { Schema } from "mongoose";

export const POPUP_TRIGGERS = ["delay", "scroll", "exit"] as const;
export const POPUP_LAYOUTS = ["modal", "slide"] as const;
export const POPUP_DEVICES = ["all", "desktop", "mobile"] as const;
export const POPUP_PAGE_MODES = ["all", "include", "exclude"] as const;

export type PopupTrigger = (typeof POPUP_TRIGGERS)[number];
export type PopupLayout = (typeof POPUP_LAYOUTS)[number];
export type PopupDevices = (typeof POPUP_DEVICES)[number];
export type PopupPageMode = (typeof POPUP_PAGE_MODES)[number];

const triggerSchema = new Schema(
  {
    type: { type: String, enum: POPUP_TRIGGERS, default: "delay" },
    delaySeconds: { type: Number, default: 8 },
    scrollPercent: { type: Number, default: 50 },
  },
  { _id: false },
);

const popupSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    siteId: { type: String, required: true },
    name: { type: String, required: true },
    formId: { type: String, required: true },
    formTitle: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    trigger: { type: triggerSchema, default: () => ({}) },
    layout: { type: String, enum: POPUP_LAYOUTS, default: "modal" },
    showAgainDays: { type: Number, default: 7 },
    pages: {
      mode: { type: String, enum: POPUP_PAGE_MODES, default: "all" },
      patterns: { type: [String], default: [] },
    },
    devices: { type: String, enum: POPUP_DEVICES, default: "all" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

popupSchema.index({ siteId: 1, enabled: 1 });

export const Popup = mongoose.model("Popup", popupSchema);
