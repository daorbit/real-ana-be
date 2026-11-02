import { isValidObjectId } from "mongoose";
import { Note, NOTE_COLORS, type NoteColor } from "./models/Note.js";
import { badRequest, notFound } from "../../shared/errors/index.js";
import { escapeRegex } from "../../shared/utils/escape-regex.js";

export const MAX_NOTES_PER_USER = 500;
const MAX_TITLE = 120;
const MAX_BODY = 20_000;

export type NotePatch = Partial<{
  title: string;
  body: string;
  color: NoteColor;
  pinned: boolean;
}>;

export function parseNotePatch(body: unknown): NotePatch | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: NotePatch = {};

  if (b.title !== undefined) {
    if (typeof b.title !== "string") return "title must be text";
    patch.title = b.title.slice(0, MAX_TITLE);
  }
  if (b.body !== undefined) {
    if (typeof b.body !== "string") return "body must be text";
    if (b.body.length > MAX_BODY) return `notes are limited to ${MAX_BODY.toLocaleString("en-US")} characters`;
    patch.body = b.body;
  }
  if (b.color !== undefined) {
    if (!NOTE_COLORS.includes(b.color as NoteColor)) return "unknown colour";
    patch.color = b.color as NoteColor;
  }
  if (b.pinned !== undefined) patch.pinned = Boolean(b.pinned);

  return patch;
}

export function presentNote(row: InstanceType<typeof Note>) {
  return {
    id: row.id as string,
    title: (row.get("title") as string) ?? "",
    body: (row.get("body") as string) ?? "",
    color: (row.get("color") as NoteColor) ?? "default",
    pinned: Boolean(row.get("pinned")),
    createdAt: row.get("createdAt") as Date,
    updatedAt: row.get("updatedAt") as Date,
  };
}

export async function findOwnedNote(userId: string | undefined, noteId: string) {
  if (!isValidObjectId(noteId)) return null;
  return Note.findOne({ _id: noteId, userId });
}

export async function createNote(userId: string | undefined, body: unknown) {
  const patch = parseNotePatch(body);
  if (typeof patch === "string") throw badRequest(patch);

  const count = await Note.countDocuments({ userId });
  if (count >= MAX_NOTES_PER_USER) {
    throw badRequest(`You can keep up to ${MAX_NOTES_PER_USER} notes. Delete a few to add more.`);
  }
  return presentNote(await Note.create({ ...patch, userId }));
}

export async function updateNote(userId: string | undefined, noteId: string, body: unknown) {
  const patch = parseNotePatch(body);
  if (typeof patch === "string") throw badRequest(patch);

  const note = await findOwnedNote(userId, noteId);
  if (!note) throw notFound("note not found");
  note.set(patch);
  await note.save();
  return presentNote(note);
}

export async function searchNotes(
  userId: string,
  query: { search?: string; pinned?: boolean; page: number; limit: number },
) {
  const filter: Record<string, unknown> = { userId };
  if (query.pinned !== undefined) filter.pinned = query.pinned;
  if (query.search) {
    const pattern = { $regex: escapeRegex(query.search), $options: "i" };
    filter.$or = [{ title: pattern }, { body: pattern }];
  }
  const [rows, total] = await Promise.all([
    Note.find(filter)
      .sort({ pinned: -1, updatedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Note.countDocuments(filter),
  ]);
  return { notes: rows.map(presentNote), total };
}
