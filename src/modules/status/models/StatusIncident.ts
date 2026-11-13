import mongoose, { Schema } from "mongoose";
import { INCIDENT_IMPACTS, INCIDENT_STATUSES, STATUS_COMPONENT_IDS } from "../components.js";

const updateSchema = new Schema(
  {
    status: { type: String, enum: INCIDENT_STATUSES, required: true },
    body: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
    authorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: true },
);

const statusIncidentSchema = new Schema(
  {
    title: { type: String, required: true },
    impact: { type: String, enum: INCIDENT_IMPACTS, required: true },
    components: { type: [{ type: String, enum: STATUS_COMPONENT_IDS }], default: [] },
    status: { type: String, enum: INCIDENT_STATUSES, required: true },
    updates: { type: [updateSchema], default: [] },
    startedAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

statusIncidentSchema.index({ resolvedAt: 1, startedAt: -1 });
statusIncidentSchema.index({ startedAt: -1 });

export const StatusIncident = mongoose.model("StatusIncident", statusIncidentSchema);
