import mongoose, { Schema } from "mongoose";

export const BIO_APPEARANCES = ["light", "dark"] as const;
export const BIO_BUTTON_STYLES = ["rounded", "pill", "square"] as const;
export const BIO_SOCIAL_NETWORKS = [
  "instagram",
  "linkedin",
  "x",
  "youtube",
  "facebook",
  "tiktok",
  "github",
  "website",
  "email",
] as const;

export type BioAppearance = (typeof BIO_APPEARANCES)[number];
export type BioButtonStyle = (typeof BIO_BUTTON_STYLES)[number];
export type BioSocialNetwork = (typeof BIO_SOCIAL_NETWORKS)[number];

const linkSchema = new Schema({
  label: { type: String, required: true },
  url: { type: String, required: true },
  enabled: { type: Boolean, default: true },
});

const socialSchema = new Schema(
  {
    network: { type: String, enum: BIO_SOCIAL_NETWORKS, required: true },
    url: { type: String, required: true },
  },
  { _id: false },
);

const bioPageSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    title: { type: String, required: true },
    bio: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    links: { type: [linkSchema], default: [] },
    socials: { type: [socialSchema], default: [] },
    theme: {
      appearance: { type: String, enum: BIO_APPEARANCES, default: "light" },
      accent: { type: String, default: "#2f6bff" },
      buttonStyle: { type: String, enum: BIO_BUTTON_STYLES, default: "rounded" },
    },
    published: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

bioPageSchema.index({ slug: 1 }, { unique: true });
bioPageSchema.index({ workspaceId: 1, createdAt: 1 });

export const BioPage = mongoose.model("BioPage", bioPageSchema);
