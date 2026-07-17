import mongoose, { Schema } from "mongoose";

/**
 * A conversion goal defined for a workspace.
 *
 * A goal matches either a pageview path (kind "page") or a custom event name
 * (kind "event"). Conversions are computed live from events at read time — a
 * goal is just the definition, so changing it re-scores past traffic rather
 * than losing history.
 */
const goalSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true },
    kind: { type: String, enum: ["page", "event"], required: true },
    // For kind "page": the path (e.g. "/thank-you"). For "event": the event name.
    match: { type: String, required: true },
  },
  { timestamps: true }
);

export const Goal = mongoose.model("Goal", goalSchema);
