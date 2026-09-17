import mongoose, { Schema, InferSchemaType } from "mongoose";

export const ROLES = ["super_admin", "admin", "user"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },

    passwordHash: { type: String, default: "" },
    googleId: { type: String, trim: true, default: "" },
    linkedinId: { type: String, trim: true, default: "" },
    name: { type: String, required: true },
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },
    mobile: { type: String, trim: true, default: "" },
    avatarUrl: { type: String, trim: true, default: "" },
    avatarPublicId: { type: String, trim: true, default: "" },
    dateLocale: { type: String, trim: true, default: "" },
    timezone: { type: String, trim: true, default: "" },
    role: { type: String, enum: ROLES, required: true, default: "user" },
    totpEnabled: { type: Boolean, default: false },
    totpSecretEnc: { type: String, default: "" },
    totpBackupCodeHashes: { type: [String], default: [] },
    pinHash: { type: String, default: "" },
    screenLockEnabled: { type: Boolean, default: false },
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = mongoose.model("User", userSchema);
