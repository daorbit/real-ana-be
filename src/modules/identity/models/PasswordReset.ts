import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * A password reset that has been requested but not yet completed.
 *
 * Deliberately shaped like `PendingSignup`, and for the same reasons: the code
 * is hashed, guesses are capped, sends are bounded, and Mongo sweeps the
 * record when it stops being useful.
 *
 * Keyed by `userId` rather than email, so that changing an address mid-flow
 * cannot leave a reset pointing at an account it no longer belongs to. The
 * email is stored alongside only so the code can be re-sent without another
 * lookup.
 *
 * Nothing here is enough to take over an account on its own: proving the code
 * is what allows a password change, and the record is destroyed the moment it
 * is used.
 */
const passwordResetSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    email: { type: String, required: true, lowercase: true, trim: true },

    /**
     * The code, hashed.
     *
     * Six digits is a small space, so read access to this collection must not
     * hand out working codes — the same reasoning that applies to the signup
     * OTP, and more consequential here, because this code changes a password
     * on an account that already exists.
     */
    codeHash: { type: String, required: true },

    /** When the current code stops being accepted. */
    expiresAt: { type: Date, required: true },

    /**
     * Wrong guesses against the current code.
     *
     * Capped, with the record destroyed on the way past the cap rather than
     * merely throttled — six digits falls to brute force in a few thousand
     * tries, which is nothing over HTTP.
     */
    attempts: { type: Number, default: 0 },

    /** Codes sent for this reset, to bound mailbox-flooding abuse. */
    sends: { type: Number, default: 1 },

    /** When the last code went out, so resends can be spaced. */
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/**
 * Let Mongo do the cleanup.
 *
 * Keyed off `createdAt` rather than `expiresAt` so that resending a code —
 * which pushes `expiresAt` out — cannot keep a reset record alive indefinitely.
 * An hour is far longer than the code's own lifetime, which is what actually
 * governs whether it works.
 */
passwordResetSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 });

export type PasswordResetDoc = InferSchemaType<typeof passwordResetSchema>;
export const PasswordReset = mongoose.model("PasswordReset", passwordResetSchema);
