import { Types } from "mongoose";
import { TaskBucket } from "./models/TaskBucket.js";
import { Task } from "./models/Task.js";
import { Workspace } from "../workspace/models/Workspace.js";

export const DEFAULT_BUCKETS = ["Backlog", "To do", "In progress", "Review", "Blocked", "Done"];
export const MAX_BUCKETS = 20;
const MAX_NAME = 40;
const DEFAULT_TASK_BUCKET = 1;

type BucketRow = { _id: Types.ObjectId; name: string; order: number };

export function presentBucket(bucket: BucketRow) {
  return { id: String(bucket._id), name: bucket.name, order: bucket.order };
}

export function parseBucketName(raw: unknown): string | null {
  const name = String((raw as { name?: unknown })?.name ?? "").replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_NAME ? name : null;
}

async function seedDefaults(workspaceId: string) {
  const claimed = await Workspace.updateOne(
    { _id: workspaceId, "apps.tasks.bucketsSeeded": { $ne: true } },
    { $set: { "apps.tasks.bucketsSeeded": true } },
  );
  if (!claimed.modifiedCount) return;

  const created = await TaskBucket.insertMany(
    DEFAULT_BUCKETS.map((name, order) => ({ workspaceId, name, order })),
  );
  await Task.updateMany(
    { workspaceId, $or: [{ bucketId: null }, { bucketId: { $exists: false } }] },
    { $set: { bucketId: created[DEFAULT_TASK_BUCKET]._id } },
  );
}

export async function workspaceBuckets(workspaceId: string) {
  await seedDefaults(workspaceId);
  const rows = await TaskBucket.find({ workspaceId }).sort({ order: 1, createdAt: 1 }).select("name order").lean();
  return rows.map((r) => presentBucket(r as unknown as BucketRow));
}

export async function bucketBelongs(workspaceId: string, bucketId: string): Promise<boolean> {
  return Types.ObjectId.isValid(bucketId) && Boolean(await TaskBucket.exists({ _id: bucketId, workspaceId }));
}

export async function firstBucketId(workspaceId: string): Promise<string | null> {
  const first = await TaskBucket.findOne({ workspaceId }).sort({ order: 1, createdAt: 1 }).select("_id").lean();
  return first ? String(first._id) : null;
}

export async function createBucket(workspaceId: string, name: string) {
  const last = await TaskBucket.findOne({ workspaceId }).sort({ order: -1 }).select("order").lean();
  const bucket = await TaskBucket.create({ workspaceId, name, order: (last?.order ?? -1) + 1 });
  return presentBucket(bucket.toObject() as unknown as BucketRow);
}

export async function deleteBucket(workspaceId: string, bucketId: string): Promise<{ ok: true; movedTo: string } | { ok: false; error: string }> {
  const buckets = await TaskBucket.find({ workspaceId }).sort({ order: 1, createdAt: 1 }).select("_id").lean();
  if (buckets.length <= 1) return { ok: false, error: "A plan needs at least one bucket" };
  const target = buckets.find((b) => String(b._id) !== bucketId);
  if (!target || !buckets.some((b) => String(b._id) === bucketId)) return { ok: false, error: "bucket not found" };

  await Promise.all([
    Task.updateMany({ workspaceId, bucketId }, { $set: { bucketId: target._id } }),
    TaskBucket.deleteOne({ _id: bucketId, workspaceId }),
  ]);
  return { ok: true, movedTo: String(target._id) };
}
