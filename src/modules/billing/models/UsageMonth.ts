import mongoose, { Schema, InferSchemaType } from "mongoose";

const usageMonthSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    month: { type: String, required: true },
    planSlug: { type: String, default: "" },
    orbitPlanSlug: { type: String, default: null },
    events: { type: Number, default: 0 },
    audits: { type: Number, default: 0 },
    crawls: { type: Number, default: 0 },
    inspections: { type: Number, default: 0 },
    formSubmissions: { type: Number, default: 0 },
    orbit: { type: Number, default: 0 },
    closedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

usageMonthSchema.index({ workspaceId: 1, month: -1 }, { unique: true });

export type UsageMonthDoc = InferSchemaType<typeof usageMonthSchema>;
export const UsageMonth = mongoose.model("UsageMonth", usageMonthSchema);
