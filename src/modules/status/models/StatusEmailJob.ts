import mongoose, { Schema } from "mongoose";

const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const statusEmailJobSchema = new Schema(
  {
    incidentId: { type: Schema.Types.ObjectId, ref: "StatusIncident", required: true },
    updateId: { type: Schema.Types.ObjectId, required: true },
    cursor: { type: Schema.Types.ObjectId, default: null },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    done: { type: Boolean, default: false },
    claimedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

statusEmailJobSchema.index({ done: 1, createdAt: 1 });
statusEmailJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const StatusEmailJob = mongoose.model("StatusEmailJob", statusEmailJobSchema);
