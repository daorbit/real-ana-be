import { Note, NOTE_COLORS, type NoteColor } from "./models/Note.js";

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
