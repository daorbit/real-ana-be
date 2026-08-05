import mongoose, { Schema } from "mongoose";

/**
 * A saved dashboard filter.
 *
 * The filter itself already exists as a URL parameter — this only makes one
 * worth keeping. Without it, "mobile visitors from Google" has to be rebuilt
 * by hand on every visit, which is the difference between a view someone
 * checks weekly and one they check once.
 *
 * Scoped to a workspace rather than a user: the filter dimensions (paths,
 * referrers, campaigns) only mean anything against that workspace's sites, so
 * a segment carried to another one would be nonsense.
 */
const segmentSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    /** Kept for ownership checks that shouldn't need to join through Workspace. */
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 60 },

    /**
     * The filter, as the dashboard's own `StatsFilter` object.
     *
     * Stored as a free-form map rather than ten named fields so a new filter
     * dimension doesn't need a migration — the keys are validated against the
     * allowed list on write, which is where an unknown key would do harm.
     */
    filter: { type: Schema.Types.Mixed, required: true },

    /**
     * Pinned segments surface as one-click chips above the dashboard; the rest
     * live behind the menu. A saved view is only a shortcut if the ones used
     * daily are reachable without opening anything.
     */
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Names are per workspace, so two workspaces can each have "Mobile — India"
// without colliding, and one workspace can't have it twice.
segmentSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export const Segment = mongoose.model("Segment", segmentSchema);
