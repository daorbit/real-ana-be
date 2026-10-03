import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Note } from "../../modules/notes/models/Note.js";
import { MAX_NOTES_PER_USER, parseNotePatch, presentNote } from "../../modules/notes/notes.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

async function findOwned(req: AuthedRequest, res: Response) {
  if (!isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "note not found" });
    return null;
  }
  const note = await Note.findOne({ _id: req.params.id, userId: req.userId });
  if (!note) res.status(404).json({ error: "note not found" });
  return note;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const notes = await Note.find({ userId: req.userId })
      .sort({ pinned: -1, updatedAt: -1 })
      .limit(MAX_NOTES_PER_USER);
    res.json(notes.map(presentNote));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const patch = parseNotePatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });

    const count = await Note.countDocuments({ userId: req.userId });
    if (count >= MAX_NOTES_PER_USER) {
      return res.status(400).json({ error: `You can keep up to ${MAX_NOTES_PER_USER} notes. Delete a few to add more.` });
    }

    const note = await Note.create({ ...patch, userId: req.userId });
    res.status(201).json(presentNote(note));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const patch = parseNotePatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });

    const note = await findOwned(req, res);
    if (!note) return;
    note.set(patch);
    await note.save();
    res.json(presentNote(note));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const note = await findOwned(req, res);
    if (!note) return;
    await note.deleteOne();
    res.status(204).end();
  }),
);

export default router;
