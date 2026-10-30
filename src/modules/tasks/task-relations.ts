import { Task } from "./models/Task.js";
import type { TaskPatch } from "./task-draft.js";

export async function checkTaskRelations(
  workspaceId: string,
  taskId: string | null,
  patch: TaskPatch,
): Promise<string | null> {
  const parentId = patch.parentId ?? null;
  const blockedBy = patch.blockedBy ?? [];
  if (!parentId && !blockedBy.length) return null;
  if (taskId && parentId === taskId) return "A task can't be its own parent";
  if (taskId && blockedBy.includes(taskId)) return "A task can't block itself";

  const [parent, hasChildren, blockerCount, mutual] = await Promise.all([
    parentId ? Task.findOne({ _id: parentId, workspaceId }).select("parentId").lean() : null,
    parentId && taskId ? Task.exists({ workspaceId, parentId: taskId }) : null,
    blockedBy.length ? Task.countDocuments({ workspaceId, _id: { $in: blockedBy } }) : 0,
    blockedBy.length && taskId ? Task.exists({ workspaceId, _id: { $in: blockedBy }, blockedBy: taskId }) : null,
  ]);
  if (parentId && !parent) return "That parent task doesn't exist";
  if (parent?.parentId) return "A subtask can't have subtasks of its own";
  if (hasChildren) return "A task with subtasks can't become a subtask";
  if (blockerCount !== blockedBy.length) return "A linked task doesn't exist";
  if (mutual) return "Two tasks can't block each other";
  return null;
}

export function checkDateOrder(start: Date | null | undefined, due: Date | null | undefined): string | null {
  return start && due && start.getTime() > due.getTime() ? "The start date must be on or before the due date" : null;
}

export async function detachTask(workspaceId: string, taskId: string) {
  await Promise.all([
    Task.updateMany({ workspaceId, parentId: taskId }, { $set: { parentId: null } }),
    Task.updateMany({ workspaceId, blockedBy: taskId }, { $pull: { blockedBy: taskId } }),
  ]);
}
