import { Router, Response } from "express";
import { isValidObjectId } from "mongoose";
import { Task } from "../../modules/tasks/models/Task.js";
import { TaskBucket } from "../../modules/tasks/models/TaskBucket.js";
import {
  MAX_BUCKETS,
  createBucket,
  deleteBucket,
  parseBucketName,
  parseBucketUpdate,
  presentBucket,
  workspaceBuckets,
} from "../../modules/tasks/buckets.service.js";
import { detachTask } from "../../modules/tasks/task-relations.js";
import { workspaceTasks } from "../../modules/tasks/tasks.service.js";
import { createTask, updateTask } from "../../modules/tasks/task-writes.service.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { APP_DISABLED_MESSAGE, appEnabled } from "../../modules/workspace/apps.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

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
    const update = parseBucketUpdate(req.body);
    if (typeof update === "string") return res.status(400).json({ error: update });
    const bucket = await TaskBucket.findOneAndUpdate(
      { _id: req.params.id, workspaceId: ws.id },
      { $set: update },
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
    res.status(201).json(await createTask(ws, req.userId, req.body));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireTasksWorkspace(req, res, "editor");
    if (!ws) return;
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "task not found" });
    res.json(await updateTask(ws, req.userId, req.params.id, req.body));
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
    await detachTask(ws.id, String(deleted._id));
    res.status(204).end();
  }),
);

export default router;
