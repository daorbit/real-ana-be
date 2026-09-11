import { Router, Response } from "express";
import { randomBytes } from "node:crypto";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { requireWorkspace } from "../../modules/workspace/access.service.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { Media } from "../../modules/media/models/Media.js";
import {
  checkAssetDataUrl,
  cloudinaryConfigured,
  deleteAsset,
  deleteAssets,
  resourceKind,
  uploadAsset,
  type ResourceKind,
} from "../../infra/storage/cloudinary.js";

/**
 * A workspace's media library.
 *
 * Mounted under `/api/workspaces/:wid/media`. One place files are uploaded to,
 * so everywhere else in the product picks from here rather than growing its
 * own upload button — a post image, a brand logo and an avatar are all the
 * same asset problem, and solving it three times is how three of them end up
 * subtly different.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(blockDemoWrites);

interface MediaShape {
  _id: unknown;
  name: string;
  alt?: string;
  url: string;
  publicId: string;
  kind: string;
  pipeline?: string;
  mime: string;
  format?: string;
  bytes?: number;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

function present(doc: MediaShape) {
  return {
    id: String(doc._id),
    name: doc.name,
    alt: doc.alt ?? "",
    url: doc.url,
    kind: doc.kind,
    mime: doc.mime,
    format: doc.format ?? "",
    bytes: doc.bytes ?? 0,
    width: doc.width ?? null,
    height: doc.height ?? null,
    // Falls back to the asset itself: a picker needs something to show, and
    // for an image the original is a valid preview.
    thumbnailUrl: doc.thumbnailUrl || (doc.kind === "image" ? doc.url : ""),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** A short opaque name, so a stored file never carries the uploader's own. */
function assetId(): string {
  return randomBytes(12).toString("hex");
}

router.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res);
    if (!ws) return;

    const { kind, q } = req.query;
    const filter: Record<string, unknown> = { workspaceId: ws.id };
    if (kind === "image" || kind === "video" || kind === "raw") filter.kind = kind;
    if (typeof q === "string" && q.trim()) {
      // Escaped: the query is typed by a person and goes straight into a
      // regex, where an unbalanced bracket would otherwise throw.
      const safe = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.name = { $regex: safe, $options: "i" };
    }

    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const perPageRaw = Number.parseInt(String(req.query.perPage ?? "40"), 10) || 40;
    const perPage = Math.min(100, Math.max(1, perPageRaw));

    const [items, total] = await Promise.all([
      Media.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean(),
      Media.countDocuments(filter),
    ]);

    res.json({
      items: (items as MediaShape[]).map(present),
      total,
      page,
      perPage,
    });
  }),
);

/**
 * Upload one or more files.
 *
 * Each is handled independently and the response says which failed, rather
 * than one bad file in a multi-select losing the whole batch.
 */
router.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    if (!cloudinaryConfigured()) {
      return res.status(503).json({ error: "file storage is not configured" });
    }

    const body = req.body ?? {};
    const raw = Array.isArray(body.files) ? body.files : [body];
    if (!raw.length || raw.length > 50) {
      return res.status(400).json({ error: "between 1 and 50 files" });
    }

    const files = raw.map((f: Record<string, unknown>) => ({
      file: typeof f?.file === "string" ? f.file : "",
      name: String(f?.name ?? "Untitled").slice(0, 160),
      alt: String(f?.alt ?? "").slice(0, 300),
    }));

    if (files.some((f: { file: string }) => !f.file)) {
      return res.status(400).json({ error: "every file must carry its data" });
    }

    const results = await Promise.all(
      files.map(async ({ file, name, alt }: { file: string; name: string; alt: string }) => {
        const checked = checkAssetDataUrl(file);
        if ("error" in checked) return { ok: false as const, name, message: checked.error };

        const kind = resourceKind(checked.mime);

        try {
          const uploaded = await uploadAsset({
            file,
            folder: `quantalog/${String(ws.id)}`,
            publicId: assetId(),
            kind,
            mime: checked.mime,
          });

          const doc = await Media.create({
            workspaceId: ws.id,
            name,
            alt,
            url: uploaded.url,
            publicId: uploaded.publicId,
            kind: uploaded.kind,
            pipeline: uploaded.pipeline,
            mime: checked.mime,
            format: uploaded.format,
            bytes: uploaded.bytes || checked.bytes,
            width: uploaded.width ?? null,
            height: uploaded.height ?? null,
            thumbnailUrl: uploaded.thumbnailUrl ?? "",
            uploadedBy: req.userId ?? null,
          });

          return { ok: true as const, doc: doc.toObject() as MediaShape };
        } catch (err) {
          return {
            ok: false as const,
            name,
            message: err instanceof Error ? err.message : "could not upload that file",
          };
        }
      }),
    );

    const items = results.filter((r) => r.ok).map((r) => present(r.doc));
    const failed = results
      .filter((r) => !r.ok)
      .map((r) => ({ name: r.name, message: r.message }));

    if (!items.length) {
      return res.status(502).json({ error: failed[0]?.message ?? "could not upload those files" });
    }

    // 207 when some succeeded and some did not, so the client can say so.
    res.status(failed.length ? 207 : 201).json({ items, failed });
  }),
);

router.post(
  "/bulk-delete",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ error: "no files named" });

    const docs = await Media.find({ _id: { $in: ids }, workspaceId: ws.id }).lean();
    if (!docs.length) return res.status(404).json({ error: "no such files" });

    await Media.deleteMany({
      _id: { $in: docs.map((d: MediaShape) => d._id) },
      workspaceId: ws.id,
    });

    // Cloudinary addresses assets per pipeline, so group before deleting.
    const byKind: Record<ResourceKind, string[]> = { image: [], video: [], raw: [] };
    for (const doc of docs as MediaShape[]) {
      byKind[(doc.pipeline ?? doc.kind) as ResourceKind]?.push(doc.publicId);
    }

    // After the response: the library already no longer lists these, and an
    // orphaned file is not worth making someone wait for.
    void Promise.all(
      (Object.keys(byKind) as ResourceKind[])
        .filter((k) => byKind[k].length)
        .map((k) => deleteAssets(byKind[k], k)),
    );

    res.json({ deleted: (docs as MediaShape[]).map((d) => String(d._id)) });
  }),
);

/** Rename, or re-word the alt text. The stored file is not touched. */
router.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    const patch: Record<string, string> = {};
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      patch.name = req.body.name.trim().slice(0, 160);
    }
    if (typeof req.body?.alt === "string") patch.alt = req.body.alt.slice(0, 300);
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to change" });

    const doc = await Media.findOneAndUpdate(
      { _id: req.params.id, workspaceId: ws.id },
      patch,
      { new: true },
    ).lean();

    if (!doc) return res.status(404).json({ error: "no such file" });
    res.json(present(doc as MediaShape));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ws = await requireWorkspace(req, res, "editor");
    if (!ws) return;

    const doc = await Media.findOneAndDelete({
      _id: req.params.id,
      workspaceId: ws.id,
    }).lean();
    if (!doc) return res.status(404).json({ error: "no such file" });

    // The row is what the library reads; the stored file is orphaned storage
    // at worst. Do not hold the response on Cloudinary.
    const asset = doc as MediaShape;
    void deleteAsset(asset.publicId, (asset.pipeline ?? asset.kind) as ResourceKind);
    res.status(204).end();
  }),
);

export default router;
