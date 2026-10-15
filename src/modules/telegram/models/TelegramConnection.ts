import mongoose, { Schema } from "mongoose";

export const TELEGRAM_VIAS = ["quantalog", "own"] as const;
export type TelegramVia = (typeof TELEGRAM_VIAS)[number];

const chatSchema = new Schema(
  {
    chatId: { type: String, required: true },
    title: { type: String, required: true, maxlength: 120 },
    type: { type: String, required: true },
    via: { type: String, enum: TELEGRAM_VIAS, required: true },
    linkedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const telegramConnectionSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, unique: true },
    ownBot: {
      tokenEnc: { type: String },
      username: { type: String },
    },
    chats: { type: [chatSchema], default: [] },
  },
  { timestamps: true }
);

telegramConnectionSchema.index({ "chats.chatId": 1 });

export const TelegramConnection = mongoose.model("TelegramConnection", telegramConnectionSchema);
