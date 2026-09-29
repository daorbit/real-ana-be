import mongoose, { Schema, InferSchemaType } from "mongoose";

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    jti: { type: String, required: true, unique: true },

    userAgent: { type: String, default: "" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
    device: { type: String, default: "" },

    ip: { type: String, default: "" },
    location: { type: String, default: "" },

    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1, revokedAt: 1 });

export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const Session = mongoose.model("Session", sessionSchema);
