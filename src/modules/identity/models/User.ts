import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * `super_admin` is not grantable through the role-change route — it exists so
 * a request body can never spoof it, only a direct DB write can set it.
 */
export const ROLES = ["super_admin", "admin", "user"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /**
     * Optional: a Google-only account has never chosen a password.
     *
     * Login reads this before comparing, so an account without one is refused
     * at the password step rather than being let through by a bcrypt compare
     * against undefined.
     */
    passwordHash: { type: String, default: "" },
    /** Google's stable subject id. Set the first time the account signs in with Google. */
    googleId: { type: String, trim: true, default: "" },
    /**
     * LinkedIn's stable OpenID subject. Set the first time the account signs in
     * with LinkedIn.
     *
     * Kept here beside `googleId` rather than being read from the connection
     * collection: that row exists to hold a posting token and can be
     * disconnected, and losing the ability to log in as a side effect of
     * revoking posting access would be a surprising way to lose an account.
     */
    linkedinId: { type: String, trim: true, default: "" },
    /**
     * Display name, derived from firstName/lastName whenever those are set.
     *
     * Kept as its own field rather than composed at read time: it predates the
     * split, it is what avatars, greetings and the admin table already read,
     * and accounts created before the split have only this.
     */
    name: { type: String, required: true },
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },
    mobile: { type: String, trim: true, default: "" },
    /** Remote image URL — either uploaded to Cloudinary, pasted by hand, or from Google. */
    avatarUrl: { type: String, trim: true, default: "" },
    /**
     * Cloudinary's handle for an uploaded avatar, so replacing one can delete
     * the file it supersedes. Empty when the avatar came from a pasted URL or
     * from Google, where there is nothing of ours to clean up.
     */
    avatarPublicId: { type: String, trim: true, default: "" },
    /** BCP 47 tag ("en-GB"). Empty means "follow the browser". */
    dateLocale: { type: String, trim: true, default: "" },
    /** IANA zone ("Asia/Kolkata"). Empty means "follow the browser". */
    timezone: { type: String, trim: true, default: "" },
    // Signups are never admins — that is granted deliberately, not requested.
    role: { type: String, enum: ROLES, required: true, default: "user" },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = mongoose.model("User", userSchema);
