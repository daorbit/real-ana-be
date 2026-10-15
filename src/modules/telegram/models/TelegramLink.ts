import mongoose, { Schema } from "mongoose";

const telegramLinkSchema = new Schema({
  code: { type: String, required: true, unique: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  expiresAt: { type: Date, required: true },
});

telegramLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TelegramLink = mongoose.model("TelegramLink", telegramLinkSchema);
