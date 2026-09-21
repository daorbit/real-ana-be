import mongoose, { Schema } from "mongoose";


const orbitMessageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "OrbitConversation",
      required: true,
      index: true,
    },


    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    seq: { type: Number, required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, maxlength: 4000 },
    imageUrl: { type: String, trim: true, default: "" },
    suggestions: { type: [String], default: [] },
    dataDigest: { type: Schema.Types.Mixed, default: undefined },
    citations: {
      type: [{ url: String, title: String, _id: false }],
      default: undefined,
    },
    failed: { type: Boolean, default: false },
    model: { type: String, trim: true, maxlength: 120, default: "" },
    modelLabel: { type: String, trim: true, maxlength: 120, default: "" },
    latencyMs: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

orbitMessageSchema.index({ conversationId: 1, seq: 1 });

export const OrbitMessage = mongoose.model("OrbitMessage", orbitMessageSchema);
