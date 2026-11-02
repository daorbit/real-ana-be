import type { presentTask } from "../tasks/tasks.service.js";
import type { presentNote } from "../notes/notes.service.js";
import { clip, MAX_TEXT } from "./limits.js";

type Task = ReturnType<typeof presentTask>;
type Note = ReturnType<typeof presentNote>;

const FULL_TEXT = 8_000;

export function presentAssistantTask(task: Task, full = false) {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    priority: task.priority,
    bucketId: task.bucketId,
    assigneeIds: task.assigneeIds,
    startDate: task.startDate,
    dueDate: task.dueDate,
    parentId: task.parentId,
    blockedBy: task.blockedBy,
    labels: task.labels,
    checklist: task.checklist,
    link: task.link,
    notes: clip(task.notes, full ? FULL_TEXT : MAX_TEXT),
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function presentAssistantNote(note: Note, full = false) {
  return {
    id: note.id,
    title: note.title,
    body: full ? note.body : clip(note.body, MAX_TEXT),
    color: note.color,
    pinned: note.pinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
