import mongoose, { Schema } from "mongoose";

const numberSchema = new Schema(
  {
    phone: { type: String, required: true },
    label: { type: String, default: "", maxlength: 60 },
    formAlerts: { type: Boolean, default: false },
    verifiedAt: { type: Date, required: true },
  },
  { _id: false }
);

const whatsAppConnectionSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, unique: true },
    enabled: { type: Boolean, default: false },
    enabledAt: { type: Date },
    numbers: { type: [numberSchema], default: [] },
  },
  { timestamps: true }
);

export const WhatsAppConnection = mongoose.model("WhatsAppConnection", whatsAppConnectionSchema);
