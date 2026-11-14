import mongoose, { Schema } from "mongoose";

export const BIO_KINDS = ["profile", "release"] as const;
export const BIO_APPEARANCES = ["light", "dark"] as const;
export const BIO_BUTTON_STYLES = ["rounded", "pill", "square"] as const;
export const BIO_BACKGROUNDS = ["plain", "soft", "accent", "deep"] as const;
export const BIO_PROFILE_LAYOUTS = ["classic", "hero", "grid", "editorial", "cards"] as const;
export const BIO_RELEASE_LAYOUTS = ["list", "poster", "tiles", "vinyl", "spotlight", "minimal"] as const;
export const BIO_FONTS = ["sans", "serif", "rounded", "mono"] as const;
export const BIO_SOCIAL_NETWORKS = [
  "instagram",
  "linkedin",
  "x",
  "youtube",
  "facebook",
  "tiktok",
  "whatsapp",
  "telegram",
  "threads",
  "github",
  "website",
  "email",
] as const;

export type BioKind = (typeof BIO_KINDS)[number];
export type BioAppearance = (typeof BIO_APPEARANCES)[number];
export type BioButtonStyle = (typeof BIO_BUTTON_STYLES)[number];
export type BioBackground = (typeof BIO_BACKGROUNDS)[number];
export type BioLayout = (typeof BIO_PROFILE_LAYOUTS)[number] | (typeof BIO_RELEASE_LAYOUTS)[number];
export type BioFont = (typeof BIO_FONTS)[number];
export type BioSocialNetwork = (typeof BIO_SOCIAL_NETWORKS)[number];

const linkSchema = new Schema({
  label: { type: String, required: true },
  url: { type: String, required: true },
  enabled: { type: Boolean, default: true },
});

const socialSchema = new Schema({
  network: { type: String, enum: BIO_SOCIAL_NETWORKS, required: true },
  url: { type: String, required: true },
  label: { type: String, default: "" },
});

const serviceRowSchema = new Schema({
  service: { type: String, required: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  action: { type: String, required: true },
  enabled: { type: Boolean, default: true },
});

const releaseSchema = new Schema(
  {
    artworkUrl: { type: String, default: "" },
    subtitle: { type: String, default: "" },
    releaseDate: { type: String, default: "" },
    rows: { type: [serviceRowSchema], default: [] },
  },
  { _id: false },
);

const bioPageSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    kind: { type: String, enum: BIO_KINDS, default: "profile" },
    slug: { type: String, required: true, lowercase: true, trim: true },
    title: { type: String, required: true },
    bio: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    links: { type: [linkSchema], default: [] },
    socials: { type: [socialSchema], default: [] },
    release: { type: releaseSchema, default: null },
    theme: {
      appearance: { type: String, enum: BIO_APPEARANCES, default: "light" },
      accent: { type: String, default: "#1d1d1f" },
      buttonStyle: { type: String, enum: BIO_BUTTON_STYLES, default: "rounded" },
      background: { type: String, enum: BIO_BACKGROUNDS, default: "plain" },
      layout: { type: String, default: "classic" },
      font: { type: String, enum: BIO_FONTS, default: "sans" },
    },
    published: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

bioPageSchema.index({ slug: 1 }, { unique: true });
bioPageSchema.index({ workspaceId: 1, createdAt: 1 });

export const BioPage = mongoose.model("BioPage", bioPageSchema);
