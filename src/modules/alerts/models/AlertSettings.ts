import mongoose, { Schema } from "mongoose";
import { ALERT_RULES, RULE_SPECS } from "../rules.js";

const rules = Object.fromEntries(
  ALERT_RULES.map((rule) => [
    rule,
    {
      enabled: { type: Boolean, default: RULE_SPECS[rule].enabled },
      value: { type: Number, default: RULE_SPECS[rule].value },
    },
  ]),
);

const alertSettingsSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, unique: true },
    rules,
    channels: {
      email: { type: Boolean, default: true },
      telegram: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
    },
    active: { type: Map, of: Date, default: {} },
    nextCheckAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

alertSettingsSchema.index({ nextCheckAt: 1 });

export const AlertSettings = mongoose.model("AlertSettings", alertSettingsSchema);
