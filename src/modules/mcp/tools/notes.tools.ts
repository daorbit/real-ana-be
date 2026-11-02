import { z } from "zod";
import { NOTE_COLORS } from "../../notes/models/Note.js";
import { createNote, findOwnedNote, presentNote, searchNotes, updateNote } from "../../notes/notes.service.js";
import { ToolError } from "../errors.js";
import { definedOnly, limitArg, objectIdArg, pageArg, paging } from "../limits.js";
import { presentAssistantNote } from "../work-presenters.js";
import type { ToolDef } from "../tool-runner.js";

const noteIdArg = objectIdArg("list_notes");

const noteFieldsInput = {
  body: z.string().max(20_000).optional().describe("The note text"),
  color: z.enum(NOTE_COLORS).optional(),
  pinned: z.boolean().optional().describe("Pinned notes stay at the top"),
};

const listNotesInput = {
  page: pageArg,
  limit: limitArg,
  search: z.string().trim().max(100).optional().describe("Case-insensitive match on the title or text"),
  pinned: z.boolean().optional().describe("Only pinned, or only unpinned, notes"),
};

export const listNotesTool: ToolDef<typeof listNotesInput> = {
  name: "list_notes",
  title: "List notes",
  description:
    "Lists your personal Quantalog notes, pinned first and then most recently edited. Notes are private to you. Text is shortened; use get_note for the full note. Paginated: use page and limit (max 25).",
  scope: "notes:read",
  app: "notes",
  input: listNotesInput,
  run: async (ctx, args) => {
    const result = await searchNotes(ctx.userId, args);
    return {
      notes: result.notes.map((n) => presentAssistantNote(n)),
      pagination: paging(args.page, args.limit, result.total),
    };
  },
};

const noteRefInput = { noteId: noteIdArg };

export const getNoteTool: ToolDef<typeof noteRefInput> = {
  name: "get_note",
  title: "Get note",
  description: "Returns one of your notes with its full text.",
  scope: "notes:read",
  app: "notes",
  input: noteRefInput,
  run: async (ctx, args) => {
    const note = await findOwnedNote(ctx.userId, args.noteId);
    if (!note) throw new ToolError("That note doesn't exist or isn't yours.");
    return presentAssistantNote(presentNote(note), true);
  },
};

const createNoteInput = {
  title: z.string().max(120).optional().describe("Short title"),
  ...noteFieldsInput,
};

export const createNoteTool: ToolDef<typeof createNoteInput> = {
  name: "create_note",
  title: "Create note",
  description: "Saves a new personal note in Quantalog Notes. Pass a title, body or both.",
  scope: "notes:write",
  app: "notes",
  writes: "create",
  input: createNoteInput,
  run: async (ctx, args) => {
    const body = definedOnly(args);
    if (!body.title?.trim() && !body.body?.trim()) throw new ToolError("A note needs a title or some text.");
    return presentAssistantNote(await createNote(ctx.userId, body), true);
  },
};

const updateNoteInput = {
  ...noteRefInput,
  title: z.string().max(120).optional(),
  ...noteFieldsInput,
};

export const updateNoteTool: ToolDef<typeof updateNoteInput> = {
  name: "update_note",
  title: "Update note",
  description:
    "Changes one of your notes: pass noteId and only the fields to change. body replaces the whole text, so to add to a note send the existing text with the addition.",
  scope: "notes:write",
  app: "notes",
  writes: "update",
  input: updateNoteInput,
  run: async (ctx, { noteId, ...fields }) => {
    const body = definedOnly(fields);
    if (!Object.keys(body).length) throw new ToolError("Pass at least one field to change.");
    return presentAssistantNote(await updateNote(ctx.userId, noteId, body), true);
  },
};
