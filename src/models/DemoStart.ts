import mongoose, { Schema } from "mongoose";

/**
 * One recorded start of the public demo.
 *
 * This exists because the throttle it backs has to hold across instances: the
 * API runs serverless, so a counter in process memory is invisible to the next
 * request and the limit stops limiting anything. A collection is the only state
 * every instance shares.
 *
 * No address is stored. `ipHash` is an HMAC of the caller's address keyed by the
 * server secret, which is enough to count "how many starts from this same
 * caller" without the row identifying anyone or the value being reversible by
 * anyone holding the database alone.
 *
 * Rows delete themselves 24 hours after they are written, so the collection
 * stays exactly as large as the window it answers for and nothing accumulates.
 */
const demoStartSchema = new Schema(
  {
    ipHash: { type: String, required: true },
    /** Set to `false` for a start that was refused, so the two can be told apart. */
    allowed: { type: Boolean, required: true, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Counting one caller's recent starts is the read on the hot path.
demoStartSchema.index({ ipHash: 1, createdAt: 1 });
// Mongo expires these on its own; nothing needs to sweep.
demoStartSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const DemoStart = mongoose.model("DemoStart", demoStartSchema);
