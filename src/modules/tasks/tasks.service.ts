import { Types } from "mongoose";
import { Task, type TaskStatus } from "./models/Task.js";
import { Membership } from "../workspace/models/Membership.js";
import { Workspace } from "../workspace/models/Workspace.js";
import { emitTo } from "../notifications/notify.service.js";

const OPEN_LIMIT = 2_000;
const DONE_LIMIT = 200;
const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TASK_FIELDS =
  "key bucketId title notes status priority assigneeId dueDate order link labels checklist checklistOnCard createdBy completedAt createdAt updatedAt";

type TaskRow = {
  _id: Types.ObjectId;
  key?: number;
  bucketId?: Types.ObjectId | null;
  labels?: { text: string; color: string }[];
  checklist?: { id: string; text: string; done: boolean }[];
  checklistOnCard?: boolean;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: string;
  assigneeId: Types.ObjectId | null;
  dueDate: Date | null;
  order: number;
  link: string;
  createdBy?: Types.ObjectId | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function presentTask(task: TaskRow) {
  return {
    id: String(task._id),
    key: task.key ?? 0,
    bucketId: task.bucketId ? String(task.bucketId) : null,
    title: task.title,
    notes: task.notes ?? "",
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId ? String(task.assigneeId) : null,
    dueDate: task.dueDate,
    order: task.order,
    link: task.link ?? "",
    labels: (task.labels ?? []).map(({ text, color }) => ({ text, color })),
    checklist: (task.checklist ?? []).map(({ id, text, done }) => ({ id, text, done })),
    checklistOnCard: task.checklistOnCard === true,
    createdBy: task.createdBy ? String(task.createdBy) : null,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export async function workspaceTasks(workspaceId: string) {
  const doneSince = new Date(Date.now() - DONE_WINDOW_MS);
  const [open, done] = await Promise.all([
    Task.find({ workspaceId, status: { $in: ["todo", "doing"] } })
      .sort({ status: 1, order: 1 })
      .limit(OPEN_LIMIT)
      .select(TASK_FIELDS)
      .lean(),
    Task.find({ workspaceId, status: "done", completedAt: { $gte: doneSince } })
      .sort({ completedAt: -1 })
      .limit(DONE_LIMIT)
      .select(TASK_FIELDS)
      .lean(),
  ]);
  return [...open, ...done].map((t) => presentTask(t as unknown as TaskRow));
}

export async function topOrder(workspaceId: string, status: TaskStatus): Promise<number> {
  const first = await Task.findOne({ workspaceId, status }).sort({ order: 1 }).select("order").lean();
  return (first?.order ?? 1) - 1;
}

export async function nextTaskKey(workspaceId: string): Promise<number> {
  const updated = await Workspace.findByIdAndUpdate(
    workspaceId,
    { $inc: { "apps.tasks.seq": 1 } },
    { new: true, projection: { "apps.tasks.seq": 1 } },
  ).lean();
  return Number((updated as { apps?: { tasks?: { seq?: number } } } | null)?.apps?.tasks?.seq ?? 0);
}

export async function isMember(workspaceId: string, userId: string): Promise<boolean> {
  return Boolean(await Membership.exists({ workspaceId, userId }));
}

export function notifyAssignee(args: {
  assigneeId: string | null | undefined;
  actorId: string | undefined;
  title: string;
  workspaceName: string;
}) {
  if (!args.assigneeId) return Promise.resolve();
  return emitTo({
    type: "task.assigned",
    userId: args.assigneeId,
    actorId: args.actorId ?? null,
    data: { title: args.title, workspaceName: args.workspaceName },
    link: "/app/tasks",
  });
}
