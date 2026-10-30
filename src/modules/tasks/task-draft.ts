import { Types, isValidObjectId } from "mongoose";
import {
  LABEL_COLORS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type LabelColor,
  type TaskPriority,
  type TaskStatus,
} from "./models/Task.js";

export type TaskPatch = {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeIds?: string[];
  startDate?: Date | null;
  dueDate?: Date | null;
  parentId?: string | null;
  blockedBy?: string[];
  order?: number;
  link?: string;
  labels?: { text: string; color: LabelColor }[];
  checklist?: { id: string; text: string; done: boolean }[];
  checklistOnCard?: boolean;
  bucketId?: string;
};

const MAX_TITLE = 200;
const MAX_NOTES = 64_000;
const MAX_LINK = 500;
const MAX_LABELS = 6;
const MAX_LABEL = 24;
const MAX_CHECK_ITEMS = 30;
const MAX_CHECK_TEXT = 200;
export const MAX_BLOCKERS = 20;

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

function parseLabels(value: unknown): TaskPatch["labels"] | string {
  if (!Array.isArray(value)) return "Labels must be a list";
  if (value.length > MAX_LABELS) return `A task can have up to ${MAX_LABELS} labels`;
  const seen = new Set<string>();
  const labels: NonNullable<TaskPatch["labels"]> = [];
  for (const raw of value) {
    const item = (raw ?? {}) as { text?: unknown; color?: unknown };
    const text = String(item.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const color = LABEL_COLORS.includes(item.color as LabelColor) ? (item.color as LabelColor) : "gray";
    labels.push({ text, color });
  }
  return labels;
}

function parseChecklist(value: unknown): TaskPatch["checklist"] | string {
  if (!Array.isArray(value)) return "The checklist must be a list";
  if (value.length > MAX_CHECK_ITEMS) return `A checklist can have up to ${MAX_CHECK_ITEMS} items`;
  const items: NonNullable<TaskPatch["checklist"]> = [];
  for (const raw of value) {
    const item = (raw ?? {}) as { id?: unknown; text?: unknown; done?: unknown };
    const text = String(item.text ?? "").trim().slice(0, MAX_CHECK_TEXT);
    const id = String(item.id ?? "").slice(0, 40);
    if (!text || !id) continue;
    items.push({ id, text, done: item.done === true });
  }
  return items;
}

function parseIdList(value: unknown, unknown: string): string[] | string {
  if (!Array.isArray(value)) return unknown;
  const ids = new Set<string>();
  for (const raw of value) {
    if (!isValidObjectId(raw)) return unknown;
    ids.add(new Types.ObjectId(String(raw)).toString());
  }
  return [...ids];
}

function parseAssigneeIds(value: unknown): string[] | string {
  return Array.isArray(value) ? parseIdList(value, "Unknown assignee") : "Assignees must be a list";
}

function parseBlockedBy(value: unknown): string[] | string {
  const ids = parseIdList(value, "Unknown linked task");
  if (typeof ids === "string") return ids;
  return ids.length > MAX_BLOCKERS ? `A task can be blocked by up to ${MAX_BLOCKERS} tasks` : ids;
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
    if (notes.length > MAX_NOTES) return "The notes are too long";
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
  if (has(body, "assigneeIds")) {
    const ids = parseAssigneeIds(body.assigneeIds);
    if (typeof ids === "string") return ids;
    patch.assigneeIds = ids;
  } else if (has(body, "assigneeId")) {
    const id = body.assigneeId;
    if (id !== null && id !== "" && !isValidObjectId(id)) return "Unknown assignee";
    patch.assigneeIds = id ? [new Types.ObjectId(String(id)).toString()] : [];
  }
  if (has(body, "startDate")) {
    const start = parseDate(body.startDate);
    if (start === "invalid") return "Invalid start date";
    patch.startDate = start;
  }
  if (has(body, "dueDate")) {
    const due = parseDate(body.dueDate);
    if (due === "invalid") return "Invalid due date";
    patch.dueDate = due;
  }
  if (has(body, "parentId")) {
    const parent = body.parentId;
    if (parent !== null && parent !== "" && !isValidObjectId(parent)) return "Unknown parent task";
    patch.parentId = parent ? new Types.ObjectId(String(parent)).toString() : null;
  }
  if (has(body, "blockedBy")) {
    const blockedBy = parseBlockedBy(body.blockedBy);
    if (typeof blockedBy === "string") return blockedBy;
    patch.blockedBy = blockedBy;
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
  if (has(body, "labels")) {
    const labels = parseLabels(body.labels);
    if (typeof labels === "string") return labels;
    patch.labels = labels;
  }
  if (has(body, "bucketId")) {
    if (!isValidObjectId(body.bucketId)) return "Unknown bucket";
    patch.bucketId = String(body.bucketId);
  }
  if (has(body, "checklistOnCard")) patch.checklistOnCard = body.checklistOnCard === true;
  if (has(body, "checklist")) {
    const checklist = parseChecklist(body.checklist);
    if (typeof checklist === "string") return checklist;
    patch.checklist = checklist;
  }
  return patch;
}
