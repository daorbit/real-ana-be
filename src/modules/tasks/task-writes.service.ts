import { Task } from "./models/Task.js";
import { parseTaskPatch } from "./task-draft.js";
import { bucketBelongs, firstBucketId } from "./buckets.service.js";
import { checkDateOrder, checkTaskRelations } from "./task-relations.js";
import { areMembers, nextTaskKey, notifyAssignees, presentTask, taskAssigneeIds, topOrder } from "./tasks.service.js";
import { canCreateFeature } from "../billing/quota.service.js";
import type { Access } from "../workspace/access.service.js";
import { badRequest, notFound, paymentRequired } from "../../shared/errors/index.js";

type TaskWorkspace = Access["workspace"];
type PresentableTask = Parameters<typeof presentTask>[0];

async function ensureTaskQuota(workspaceId: string) {
  const allowed = await canCreateFeature(workspaceId, "tasks");
  if (!allowed.ok) {
    throw paymentRequired(allowed.error, { code: allowed.code ?? "quota_exceeded", ...(allowed.limit ? { limit: allowed.limit } : {}) });
  }
}

function sameMembers(next: string[], previous: string[]) {
  return next.length === previous.length && next.every((id) => previous.includes(id));
}

export async function createTask(ws: TaskWorkspace, actorId: string | undefined, body: unknown) {
  const draft = parseTaskPatch(body, { requireTitle: true });
  if (typeof draft === "string") throw badRequest(draft);
  const dateError = checkDateOrder(draft.startDate, draft.dueDate);
  if (dateError) throw badRequest(dateError);

  const [assigneeOk, bucketOk, fallbackBucket, relationError] = await Promise.all([
    areMembers(ws.id, draft.assigneeIds ?? []),
    draft.bucketId ? bucketBelongs(ws.id, draft.bucketId) : true,
    draft.bucketId ? null : firstBucketId(ws.id),
    checkTaskRelations(ws.id, null, draft),
  ]);
  if (!assigneeOk) throw badRequest("Every assignee must be a member of this workspace");
  if (!bucketOk) throw badRequest("That bucket doesn't exist");
  if (relationError) throw badRequest(relationError);
  if (!draft.bucketId && fallbackBucket) draft.bucketId = fallbackBucket;

  const status = draft.status ?? "todo";
  if (status !== "done") await ensureTaskQuota(ws.id);

  const [key, order] = await Promise.all([nextTaskKey(ws.id), draft.order ?? topOrder(ws.id, status)]);
  const task = await Task.create({
    workspaceId: ws.id,
    ...draft,
    key,
    status,
    order,
    completedAt: status === "done" ? new Date() : null,
    createdBy: actorId,
  });

  await notifyAssignees({
    assigneeIds: draft.assigneeIds ?? [],
    actorId,
    title: task.title,
    workspaceName: String(ws.get("name") ?? ""),
  });
  return presentTask(task.toObject() as unknown as PresentableTask);
}

export async function updateTask(ws: TaskWorkspace, actorId: string | undefined, taskId: string, body: unknown) {
  const task = await Task.findOne({ _id: taskId, workspaceId: ws.id });
  if (!task) throw notFound("task not found");

  const patch = parseTaskPatch(body, { requireTitle: false });
  if (typeof patch === "string") throw badRequest(patch);

  const previousAssignees = taskAssigneeIds(task);
  const assigneeChanged = patch.assigneeIds !== undefined && !sameMembers(patch.assigneeIds, previousAssignees);
  const dateError = checkDateOrder(
    patch.startDate !== undefined ? patch.startDate : task.startDate,
    patch.dueDate !== undefined ? patch.dueDate : task.dueDate,
  );
  if (dateError) throw badRequest(dateError);

  const [assigneesOk, bucketOk, relationError] = await Promise.all([
    assigneeChanged ? areMembers(ws.id, patch.assigneeIds ?? []) : true,
    patch.bucketId ? bucketBelongs(ws.id, patch.bucketId) : true,
    checkTaskRelations(ws.id, String(task._id), patch),
  ]);
  if (!assigneesOk) throw badRequest("Every assignee must be a member of this workspace");
  if (!bucketOk) throw badRequest("That bucket doesn't exist");
  if (relationError) throw badRequest(relationError);

  const reopening = patch.status !== undefined && patch.status !== "done" && task.status === "done";
  if (reopening) await ensureTaskQuota(ws.id);

  if (patch.status !== undefined && patch.status !== task.status)
    task.set("completedAt", patch.status === "done" ? new Date() : null);
  task.set(patch);
  await task.save();

  if (assigneeChanged)
    await notifyAssignees({
      assigneeIds: (patch.assigneeIds ?? []).filter((id) => !previousAssignees.includes(id)),
      actorId,
      title: task.title,
      workspaceName: String(ws.get("name") ?? ""),
    });
  return presentTask(task.toObject() as unknown as PresentableTask);
}
