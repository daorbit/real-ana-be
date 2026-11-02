import { Router, Response } from "express";
import { Note } from "../../modules/notes/models/Note.js";
import {
  MAX_NOTES_PER_USER,
  createNote,
  findOwnedNote,
  presentNote,
  updateNote,
} from "../../modules/notes/notes.service.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

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
    res.status(201).json(await createNote(req.userId, req.body));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await updateNote(req.userId, req.params.id, req.body));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const note = await findOwnedNote(req.userId, req.params.id);
    if (!note) return res.status(404).json({ error: "note not found" });
    await note.deleteOne();
    res.status(204).end();
  }),
);

export default router;
