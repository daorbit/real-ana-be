import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Task } from "../../modules/tasks/models/Task.js";
import { parseTaskPatch } from "../../modules/tasks/task-draft.js";
import { TaskBucket } from "../../modules/tasks/models/TaskBucket.js";
import {
  MAX_BUCKETS,
  bucketBelongs,
  createBucket,
  deleteBucket,
  firstBucketId,
  parseBucketName,
  presentBucket,
  workspaceBuckets,
} from "../../modules/tasks/buckets.service.js";
import {
  areMembers,
  nextTaskKey,
  notifyAssignees,
  presentTask,
  taskAssigneeIds,
  topOrder,
  workspaceTasks,
} from "../../modules/tasks/tasks.service.js";
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
    const buckets = await workspaceBuckets(ws.id);
    res.json({ buckets, tasks: await workspaceTasks(ws.id) });
  }),
);

router.post(
  "/buckets",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;
    const name = parseBucketName(req.body);
    if (!name) return res.status(400).json({ error: "A bucket needs a name of up to 40 characters" });
    if ((await TaskBucket.countDocuments({ workspaceId: ws.id })) >= MAX_BUCKETS)
      return res.status(400).json({ error: `A plan can have up to ${MAX_BUCKETS} buckets` });
    res.status(201).json(await createBucket(ws.id, name));
  }),
);

router.patch(
  "/buckets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "bucket not found" });
    const name = parseBucketName(req.body);
    if (!name) return res.status(400).json({ error: "A bucket needs a name of up to 40 characters" });
    const bucket = await TaskBucket.findOneAndUpdate(
      { _id: req.params.id, workspaceId: ws.id },
      { $set: { name } },
      { new: true },
    ).lean();
    if (!bucket) return res.status(404).json({ error: "bucket not found" });
    res.json(presentBucket(bucket as unknown as Parameters<typeof presentBucket>[0]));
  }),
);

router.delete(
  "/buckets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "bucket not found" });
    const result = await deleteBucket(ws.id, req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ movedTo: result.movedTo });
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;

    const draft = parseTaskPatch(req.body, { requireTitle: true });
    if (typeof draft === "string") return res.status(400).json({ error: draft });
    const [assigneeOk, bucketOk, fallbackBucket] = await Promise.all([
      areMembers(ws.id, draft.assigneeIds ?? []),
      draft.bucketId ? bucketBelongs(ws.id, draft.bucketId) : true,
      draft.bucketId ? null : firstBucketId(ws.id),
    ]);
    if (!assigneeOk) return res.status(400).json({ error: "Every assignee must be a member of this workspace" });
    if (!bucketOk) return res.status(400).json({ error: "That bucket doesn't exist" });
    if (!draft.bucketId && fallbackBucket) draft.bucketId = fallbackBucket;

    const status = draft.status ?? "todo";
    if (status !== "done") {
      const allowed = await canCreateFeature(ws.id, "tasks");
      if (!allowed.ok) return planLimit(res, allowed.error, allowed.limit, allowed.code);
    }

    const [key, order] = await Promise.all([
      nextTaskKey(ws.id),
      draft.order ?? topOrder(ws.id, status),
    ]);
    const task = await Task.create({
      workspaceId: ws.id,
      ...draft,
      key,
      status,
      order,
      completedAt: status === "done" ? new Date() : null,
      createdBy: req.userId,
    });

    await notifyAssignees({
      assigneeIds: draft.assigneeIds ?? [],
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

    const previousAssignees = taskAssigneeIds(task);
    const assigneeChanged =
      patch.assigneeIds !== undefined &&
      (patch.assigneeIds.length !== previousAssignees.length ||
        patch.assigneeIds.some((id) => !previousAssignees.includes(id)));
    if (assigneeChanged && !(await areMembers(ws.id, patch.assigneeIds ?? [])))
      return res.status(400).json({ error: "Every assignee must be a member of this workspace" });

    if (patch.bucketId && !(await bucketBelongs(ws.id, patch.bucketId)))
      return res.status(400).json({ error: "That bucket doesn't exist" });

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
      await notifyAssignees({
        assigneeIds: (patch.assigneeIds ?? []).filter((id) => !previousAssignees.includes(id)),
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
