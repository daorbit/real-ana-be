import { isValidObjectId } from "mongoose";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "./models/Task.js";

export type TaskPatch = {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: Date | null;
  order?: number;
  link?: string;
};

const MAX_TITLE = 200;
const MAX_NOTES = 4000;
const MAX_LINK = 500;

function has(body: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function parseDate(value: unknown): Date | null | "invalid" {
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function parseLink(value: unknown): string | "invalid" {
  const link = String(value ?? "").trim();
  if (!link) return "";
  if (link.length > MAX_LINK) return "invalid";
  if (link.startsWith("/app/")) return link;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "invalid";
  } catch {
    return "invalid";
  }
}

export function parseTaskPatch(raw: unknown, { requireTitle }: { requireTitle: boolean }): TaskPatch | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const patch: TaskPatch = {};

  if (requireTitle || has(body, "title")) {
    const title = String(body.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) return "A task needs a title";
    if (title.length > MAX_TITLE) return `Keep the title under ${MAX_TITLE} characters`;
    patch.title = title;
  }
  if (has(body, "notes")) {
    const notes = String(body.notes ?? "").trim();
    if (notes.length > MAX_NOTES) return `Keep the notes under ${MAX_NOTES} characters`;
    patch.notes = notes;
  }
  if (has(body, "status")) {
    if (!TASK_STATUSES.includes(body.status as TaskStatus)) return "Unknown status";
    patch.status = body.status as TaskStatus;
  }
  if (has(body, "priority")) {
    if (!TASK_PRIORITIES.includes(body.priority as TaskPriority)) return "Unknown priority";
    patch.priority = body.priority as TaskPriority;
  }
  if (has(body, "assigneeId")) {
    const id = body.assigneeId;
    if (id !== null && id !== "" && !isValidObjectId(id)) return "Unknown assignee";
    patch.assigneeId = id ? String(id) : null;
  }
  if (has(body, "dueDate")) {
    const due = parseDate(body.dueDate);
    if (due === "invalid") return "Invalid due date";
    patch.dueDate = due;
  }
  if (has(body, "order")) {
    const order = Number(body.order);
    if (!Number.isFinite(order)) return "Invalid order";
    patch.order = order;
  }
  if (has(body, "link")) {
    const link = parseLink(body.link);
    if (link === "invalid") return "The link must be a web address or a Quantalog page";
    patch.link = link;
  }
  return patch;
}
