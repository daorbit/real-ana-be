import mongoose, { Schema } from "mongoose";
import { ACTION_NAMES } from "../actions.js";

export const AUDIT_RETENTION_DAYS = 400;

const auditLogSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    impersonatorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, enum: ACTION_NAMES, required: true },
    target: {
      kind: { type: String, default: "" },
      id: { type: String, default: "" },
      label: { type: String, default: "" },
    },
    meta: { type: Schema.Types.Mixed, default: {} },
    source: { type: String, enum: ["dashboard", "forms"], default: "dashboard" },
    ip: { type: String, default: "" },
    location: { type: String, default: "" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ workspaceId: 1, createdAt: -1 });
auditLogSchema.index({ workspaceId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ workspaceId: 1, actorId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 60 * 60 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
