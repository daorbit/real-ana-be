import mongoose, { Schema } from "mongoose";

const whatsAppVerificationSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  phone: { type: String, required: true },
  label: { type: String, default: "" },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

whatsAppVerificationSchema.index({ workspaceId: 1, phone: 1 }, { unique: true });
whatsAppVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WhatsAppVerification = mongoose.model("WhatsAppVerification", whatsAppVerificationSchema);
