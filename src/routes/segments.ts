import { Router, Response } from "express";
import { Segment } from "../models/Segment.js";
import { Workspace } from "../models/Workspace.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../auth.js";

/**
 * Saved dashboard filters, owned by the workspace owner.
 *
 * Mounted under `/api/workspaces/:wid/segments`, so ownership is checked the
 * same way every other workspace-scoped route checks it: the workspace belongs
 * to the caller, or it doesn't exist as far as they're concerned.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

/**
 * Filter dimensions a segment may reference.
 *
 * Mirrors `StatsFilter` on the client and, more importantly, the keys
 * `parseFilters` understands server-side. Validated on write rather than on
 * read: an unknown key saved today would silently do nothing forever, and the
 * person who saved it would think their segment was working.
 */
const ALLOWED_KEYS = [
  "country",
  "device",
  "browser",
  "os",
  "referrer",
  "path",
  "language",
  "utmSource",
  "utmCampaign",
  "eventName",
] as const;

/** A single filter value can't be unbounded — it ends up in a query. */
const MAX_VALUE_LENGTH = 200;

/** The caller's workspace, or null — never "someone else's workspace". */
async function ownedWorkspace(req: AuthedRequest) {
  return Workspace.findOne({ _id: req.params.wid, userId: req.userId });
}

function present(segment: InstanceType<typeof Segment>) {
  return {
    id: segment.id,
    name: segment.get("name"),
    filter: segment.get("filter"),
    pinned: segment.get("pinned"),
    createdAt: segment.get("createdAt"),
  };
}

/**
 * Validate and narrow a submitted filter to the keys we understand.
 *
 * Returns the cleaned object rather than the caller's, so nothing unexpected
 * reaches the database — a segment is replayed into a query later, and the
 * moment to reject a key we can't honour is now.
 */
function cleanFilter(
  input: unknown,
): { ok: true; filter: Record<string, string> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "filter must be an object" };

  const filter: Record<string, string> = {};

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key))
      return { ok: false, error: `unknown filter "${key}"` };

    // An empty value narrows nothing; dropping it keeps a segment from
    // claiming a dimension it doesn't actually constrain.
    const text = String(value ?? "").trim();
    if (!text) continue;

    if (text.length > MAX_VALUE_LENGTH)
      return { ok: false, error: `filter "${key}" is too long` };

    filter[key] = text;
  }

  if (!Object.keys(filter).length)
    return { ok: false, error: "a segment needs at least one filter" };

  return { ok: true, filter };
}

/** Pinned first, then newest — the order they're offered in the UI. */
router.get("/", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const segments = await Segment.find({ workspaceId: ws.id }).sort({
    pinned: -1,
    createdAt: -1,
  });

  res.json(segments.map(present));
});

router.post("/", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  if (name.length > 60) return res.status(400).json({ error: "name is too long" });

  const cleaned = cleanFilter(req.body?.filter);
  if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });

  try {
    const segment = await Segment.create({
      workspaceId: ws.id,
      userId: req.userId,
      name,
      filter: cleaned.filter,
      pinned: Boolean(req.body?.pinned),
    });
    res.status(201).json(present(segment));
  } catch (e) {
    // The unique index on (workspaceId, name) is what enforces this — a
    // find-then-insert would let two near-simultaneous saves both pass.
    if ((e as { code?: number }).code === 11000)
      return res.status(409).json({ error: "a segment with that name already exists" });
    throw e;
  }
});

/** Rename, re-filter, or pin. Every field is optional — this backs both a rename and a pin toggle. */
router.patch("/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const update: Record<string, unknown> = {};

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "name cannot be empty" });
    if (name.length > 60) return res.status(400).json({ error: "name is too long" });
    update.name = name;
  }

  if (req.body?.filter !== undefined) {
    const cleaned = cleanFilter(req.body.filter);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });
    update.filter = cleaned.filter;
  }

  if (req.body?.pinned !== undefined) update.pinned = Boolean(req.body.pinned);

  if (!Object.keys(update).length)
    return res.status(400).json({ error: "nothing to update" });

  try {
    // Scoped by workspace as well as id, so an id from another workspace is a
    // 404 rather than an edit.
    const segment = await Segment.findOneAndUpdate(
      { _id: req.params.id, workspaceId: ws.id },
      { $set: update },
      { new: true },
    );
    if (!segment) return res.status(404).json({ error: "segment not found" });
    res.json(present(segment));
  } catch (e) {
    if ((e as { code?: number }).code === 11000)
      return res.status(409).json({ error: "a segment with that name already exists" });
    throw e;
  }
});

router.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const ws = await ownedWorkspace(req);
  if (!ws) return res.status(404).json({ error: "workspace not found" });

  const result = await Segment.deleteOne({ _id: req.params.id, workspaceId: ws.id });
  if (!result.deletedCount) return res.status(404).json({ error: "segment not found" });

  res.json({ ok: true });
});

export default router;
