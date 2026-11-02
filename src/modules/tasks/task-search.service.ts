import { Types } from "mongoose";
import { Task, type TaskPriority } from "./models/Task.js";
import { workspaceBuckets } from "./buckets.service.js";
import { presentTask } from "./tasks.service.js";
import { Membership } from "../workspace/models/Membership.js";
import { User } from "../identity/models/User.js";
import { escapeRegex } from "../../shared/utils/escape-regex.js";

export type TaskStatusFilter = "open" | "todo" | "doing" | "done" | "all";
export type TaskSort = "board" | "due" | "updated" | "created";

export type TaskSearch = {
  status: TaskStatusFilter;
  bucketId?: string;
  assigneeId?: string;
  priority?: TaskPriority;
  parentId?: string;
  search?: string;
  dueBefore?: Date;
  sort: TaskSort;
  page: number;
  limit: number;
};

const SORTS: Record<TaskSort, Record<string, 1 | -1>> = {
  board: { status: 1, order: 1 },
  due: { dueDate: 1, order: 1 },
  updated: { updatedAt: -1 },
  created: { createdAt: -1 },
};

const STATUS_FILTERS: Record<TaskStatusFilter, unknown> = {
  open: { $in: ["todo", "doing"] },
  todo: "todo",
  doing: "doing",
  done: "done",
  all: undefined,
};

function searchFilter(workspaceId: string, query: TaskSearch): Record<string, unknown> {
  const filter: Record<string, unknown> = { workspaceId };
  const status = STATUS_FILTERS[query.status];
  if (status !== undefined) filter.status = status;
  if (query.bucketId) filter.bucketId = new Types.ObjectId(query.bucketId);
  if (query.priority) filter.priority = query.priority;
  if (query.parentId) filter.parentId = new Types.ObjectId(query.parentId);
  if (query.dueBefore) filter.dueDate = { $ne: null, $lte: query.dueBefore };
  if (query.search) filter.title = { $regex: escapeRegex(query.search), $options: "i" };
  if (query.assigneeId) {
    const id = new Types.ObjectId(query.assigneeId);
    filter.$or = [{ assigneeIds: id }, { assigneeIds: { $exists: false }, assigneeId: id }];
  }
  return filter;
}

export async function searchTasks(workspaceId: string, query: TaskSearch) {
  const filter = searchFilter(workspaceId, query);
  const [rows, total] = await Promise.all([
    Task.find(filter)
      .sort(SORTS[query.sort])
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Task.countDocuments(filter),
  ]);
  return { tasks: rows.map((t) => presentTask(t as unknown as Parameters<typeof presentTask>[0])), total };
}

export async function findTask(workspaceId: string, ref: { taskId?: string; key?: number }) {
  const filter = ref.taskId ? { workspaceId, _id: ref.taskId } : { workspaceId, key: ref.key };
  const row = await Task.findOne(filter).lean();
  return row ? presentTask(row as unknown as Parameters<typeof presentTask>[0]) : null;
}

export async function assignableMembers(workspaceId: string) {
  const memberships = await Membership.find({ workspaceId }).select("userId role").lean();
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } })
    .select("name email")
    .lean();
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  return memberships.map((m) => {
    const user = usersById.get(String(m.userId));
    return {
      id: String(m.userId),
      name: String(user?.name ?? ""),
      email: String(user?.email ?? ""),
      role: m.role,
    };
  });
}

export async function openTaskCounts(workspaceId: string) {
  const rows = await Task.aggregate<{ _id: Types.ObjectId | null; count: number }>([
    { $match: { workspaceId: new Types.ObjectId(workspaceId), status: { $in: ["todo", "doing"] } } },
    { $group: { _id: "$bucketId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

export async function taskBoard(workspaceId: string) {
  const [buckets, members, counts] = await Promise.all([
    workspaceBuckets(workspaceId),
    assignableMembers(workspaceId),
    openTaskCounts(workspaceId),
  ]);
  return {
    buckets: buckets.map((b) => ({ ...b, openTasks: counts.get(b.id) ?? 0 })),
    members,
  };
}
