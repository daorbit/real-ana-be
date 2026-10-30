import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Task } from "../../modules/tasks/models/Task.js";
import { parseTaskPatch } from "../../modules/tasks/task-draft.js";
import { isMember, notifyAssignee, presentTask, topOrder, workspaceTasks } from "../../modules/tasks/tasks.service.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";
import { canCreateFeature } from "../../modules/billing/quota.service.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

async function requireTasksWorkspace(req: AuthedRequest, res: Response, minimum?: WorkspaceRole) {
  const ws = await requireWorkspace(req, res, minimum);
  if (!ws) return null;
  if (!appEnabled(ws, "tasks")) {
    res.status(403).json({ error: APP_DISABLED_MESSAGE.tasks });
    return null;
  }
  return ws;
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res);
    if (!ws) return;
    res.json(await workspaceTasks(ws.id));
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;

    const draft = parseTaskPatch(req.body, { requireTitle: true });
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    if (draft.assigneeId && !(await isMember(ws.id, draft.assigneeId)))
      return res.status(400).json({ error: "The assignee isn't a member of this workspace" });

    const status = draft.status ?? "todo";
    if (status !== "done") {
      const allowed = await canCreateFeature(ws.id, "tasks");
      if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);
    }

    const task = await Task.create({
      workspaceId: ws.id,
      ...draft,
      status,
      order: draft.order ?? (await topOrder(ws.id, status)),
      completedAt: status === "done" ? new Date() : null,
      createdBy: req.userId,
    });

    await notifyAssignee({
      assigneeId: draft.assigneeId,
      actorId: req.userId,
      title: task.title,
      workspaceName: String(ws.get("name") ?? ""),
    });
    res.status(201).json(presentTask(task.toObject() as unknown as Parameters<typeof presentTask>[0]));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "task not found" });

    const task = await Task.findOne({ _id: req.params.id, workspaceId: ws.id });
    if (!task) return res.status(404).json({ error: "task not found" });

    const patch = parseTaskPatch(req.body, { requireTitle: false });
    if (typeof patch === "string") return res.status(400).json({ error: patch });

    const previousAssignee = task.assigneeId ? String(task.assigneeId) : null;
    const assigneeChanged = patch.assigneeId !== undefined && patch.assigneeId !== previousAssignee;
    if (assigneeChanged && patch.assigneeId && !(await isMember(ws.id, patch.assigneeId)))
      return res.status(400).json({ error: "The assignee isn't a member of this workspace" });

    const reopening = patch.status !== undefined && patch.status !== "done" && task.status === "done";
    if (reopening) {
      const allowed = await canCreateFeature(ws.id, "tasks");
      if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);
    }

    if (patch.status !== undefined && patch.status !== task.status)
      task.set("completedAt", patch.status === "done" ? new Date() : null);
    task.set(patch);
    await task.save();

    if (assigneeChanged)
      await notifyAssignee({
        assigneeId: patch.assigneeId,
        actorId: req.userId,
        title: task.title,
        workspaceName: String(ws.get("name") ?? ""),
      });
    res.json(presentTask(task.toObject() as unknown as Parameters<typeof presentTask>[0]));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "task not found" });

    const deleted = await Task.findOneAndDelete({ _id: req.params.id, workspaceId: ws.id });
    if (!deleted) return res.status(404).json({ error: "task not found" });
    res.status(204).end();
  }),
);

export default router;
