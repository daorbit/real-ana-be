import mongoose, { Schema } from "mongoose";

/**
 * How one workspace presents itself to the people it collects from.
 *
 * Kept here rather than in the forms service because a workspace is one
 * business, not one product: the name on a payment window, the caption under a
 * public form and the footer of a notification email are the same claim about
 * who is asking, and two services holding their own copy is how they end up
 * disagreeing in front of a customer.
 *
 * Every field is optional. Absent means "use ours" — see `resolveBranding`.
 */
const brandingSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
    },
    /** Business name shown on checkouts, form footers and email footers. */
    name: { type: String, trim: true, maxlength: 60 },
    /** Square logo by URL. Fetched by the respondent's browser, not by us. */
    logoUrl: { type: String, trim: true, maxlength: 2048 },
    /** Hex accent used where a brand colour is accepted, e.g. the checkout. */
    accentColor: { type: String, trim: true, maxlength: 9 },
    /**
     * Whether "Powered by Quantalog Forms" is hidden.
     *
     * Stored even for workspaces whose plan does not allow it: a customer who
     * downgrades should get their choice back on upgrading rather than have it
     * silently erased, so the plan is checked when the value is *read*, never
     * by refusing to remember it.
     */
    hidePoweredBy: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type BrandingDoc = mongoose.InferSchemaType<typeof brandingSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Branding =
  mongoose.models.Branding ?? mongoose.model("Branding", brandingSchema);
