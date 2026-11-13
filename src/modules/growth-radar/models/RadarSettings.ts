import mongoose, { Schema } from "mongoose";

const radarSettingsSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    detectors: { type: Schema.Types.Mixed, default: {} },
    notifyHighPriority: { type: Boolean, default: true },
    aiExplanations: { type: Boolean, default: true },
  },
  { timestamps: true },
);

radarSettingsSchema.index({ workspaceId: 1 }, { unique: true });

export const RadarSettings = mongoose.model("RadarSettings", radarSettingsSchema);
