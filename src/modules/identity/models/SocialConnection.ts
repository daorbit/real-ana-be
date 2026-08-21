import mongoose, { Schema, InferSchemaType } from "mongoose";

/**
 * A third-party account a user has connected to their Quantalog account.
 *
 * Written generically rather than as a LinkedIn-only model: the Share Panel
 * already offers five networks, and the next one to gain a real integration
 * should add a value to `PROVIDERS` rather than a parallel collection with the
 * same six columns.
 *
 * Scoped to the user, not the workspace. An OAuth token is issued to the person
 * who authorised it and posts under their name — handing it to everyone in a
 * workspace would publish as one member on another member's action.
 *
 * The access token is the sensitive part and is stored encrypted; see
 * `crypto-box`. Nothing here is ever returned to the client verbatim — the
 * status route projects a small profile subset by hand.
 */
export const PROVIDERS = ["linkedin", "instagram"] as const;
export type Provider = (typeof PROVIDERS)[number];

const socialConnectionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: { type: String, enum: PROVIDERS, required: true },

    /**
     * The provider's stable subject id — LinkedIn's `sub` from the OpenID
     * userinfo response, Instagram's app-scoped `user_id`. The only identifier
     * that survives a name or email change on the far side, and for Instagram
     * the id every publish call is addressed to.
     */
    providerUserId: { type: String, required: true, trim: true },

    /**
     * Profile fields, cached so the panel can say who is connected without a
     * round-trip.
     *
     * `name` holds whatever the provider calls its display identity: a member's
     * real name on LinkedIn, the `@username` on Instagram. `email` is LinkedIn
     * only — `instagram_business_basic` does not carry an address, and asking
     * for one would mean a Facebook Login scope this flow deliberately avoids —
     * so it stays empty on an Instagram row rather than being faked.
     */
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    picture: { type: String, trim: true, default: "" },

    /**
     * The access token, encrypted at rest.
     *
     * `select: false` so it is left out of every query that does not ask for it
     * by name. The status route and the panel have no use for it, and the
     * default-excluded shape means a future handler cannot leak it just by
     * forgetting to project.
     */
    accessToken: { type: String, required: true, select: false },

    /**
     * When the access token stops working. Both providers issue ~60-day tokens,
     * though only Instagram's can be extended in place — see
     * `refreshLongLivedToken`.
     */
    expiresAt: { type: Date, required: true },

    /**
     * The scopes the token was actually granted.
     *
     * Recorded because both providers return what they approved, not what was
     * asked for: a LinkedIn app missing a product grants a subset silently, and
     * an Instagram user can decline publishing on the consent screen while
     * still completing the connection. Posting would otherwise fail later with
     * nothing explaining why.
     */
    scope: { type: String, default: "" },
  },
  { timestamps: true }
);

/**
 * One connection per user per provider.
 *
 * The uniqueness is what makes re-connecting an update instead of a duplicate:
 * the callback upserts on this key, so authorising twice — or authorising a
 * different LinkedIn account — replaces the stored token rather than leaving
 * two rows and an ambiguous "which one posts?".
 */
socialConnectionSchema.index({ userId: 1, provider: 1 }, { unique: true });

export type SocialConnectionDoc = InferSchemaType<typeof socialConnectionSchema>;
export const SocialConnection = mongoose.model("SocialConnection", socialConnectionSchema);
