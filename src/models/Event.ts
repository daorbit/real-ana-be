import mongoose, { Schema } from "mongoose";

const eventSchema = new Schema(
  {
    type: { type: String, required: true },
    path: { type: String, default: "/" },
    userId: { type: String },
  },
  { timestamps: true }
);

export const Event = mongoose.model("Event", eventSchema);
