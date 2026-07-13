import mongoose, { Schema, InferSchemaType } from "mongoose";

export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    // Signups are never admins — that is granted deliberately, not requested.
    role: { type: String, enum: ROLES, required: true, default: "user" },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = mongoose.model("User", userSchema);
