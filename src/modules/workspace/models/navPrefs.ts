import { Schema } from "mongoose";

const navLinkSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, trim: true, maxlength: 40, required: true },
    url: { type: String, trim: true, maxlength: 2048, required: true },
    mode: { type: String, enum: ["external", "internal"], default: "external" },
    slug: { type: String, trim: true, maxlength: 40, default: "" },
    logoUrl: { type: String, trim: true, default: "" },
    logoPublicId: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

export const navPrefsSchema = new Schema(
  {
    hidden: { type: [String], default: [] },
    pinned: { type: [String], default: [] },
    links: { type: [navLinkSchema], default: [] },
  },
  { _id: false },
);
