import mongoose, { Schema } from "mongoose";

export const NOTE_COLORS = ["default", "amber", "emerald", "sky", "rose", "violet"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

const noteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    color: { type: String, enum: NOTE_COLORS, default: "default" },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

noteSchema.index({ userId: 1, pinned: -1, updatedAt: -1 });

export const Note = mongoose.model("Note", noteSchema);
