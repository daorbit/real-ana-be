import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * A signup that has been submitted but not yet proved.
 *
 * Nothing lands in `users` until a code is verified, so an unfinished or
 * abandoned signup never becomes an account: the email stays free for whoever
 * actually owns it, the unique index on `users.email` keeps meaning "a real
 * account exists", and there is no half-made row for the rest of the app to
 * trip over.
 *
 * The password is hashed here, at submit time, exactly as it would be on the
 * user record — a plaintext password sitting in a collection waiting for
 * someone to check their inbox would be a worse leak than the one this flow
 * exists to prevent.
 */
const pendingSignupSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },

    /**
     * The code, hashed.
     *
     * Six digits is a small space, so this is stored hashed for the same reason
     * the password is: read access to this collection should not hand out
     * working codes. Cheap to compare, and the value is short-lived anyway.
     */
    codeHash: { type: String, required: true },

    /** When the current code stops being accepted. */
    expiresAt: { type: Date, required: true },

    /**
     * Wrong guesses against the current code.
     *
     * Six digits falls to brute force in a few thousand tries, which is nothing
     * over HTTP — so attempts are capped and the record is destroyed on the way
     * past the cap, rather than merely rate-limited.
     */
    attempts: { type: Number, default: 0 },

    /** Codes sent for this signup, to bound resend abuse. */
    sends: { type: Number, default: 1 },

    /** When the last code went out, so resends can be spaced. */
    lastSentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/**
 * Let Mongo do the cleanup.
 *
 * A pending signup is worthless an hour after it was started, and nothing else
 * in the app ever reads an expired one. The TTL index means abandoned attempts
 * disappear on their own instead of accumulating — and it is keyed off
 * `createdAt` rather than `expiresAt` so that resending a code (which pushes
 * `expiresAt` out) cannot keep a record alive indefinitely.
 */
pendingSignupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 });

export type PendingSignupDoc = InferSchemaType<typeof pendingSignupSchema>;
export const PendingSignup = mongoose.model("PendingSignup", pendingSignupSchema);
