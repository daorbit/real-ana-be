import { createHash } from "node:crypto";
import axios from "axios";

/**
 * Cloudinary uploads, over their REST API.
 *
 * The official SDK is not used deliberately: it is one dependency and one
 * multipart pipeline for what is a single signed form POST. Images arrive as
 * data URLs in a JSON body, which Cloudinary accepts as a `file` value directly,
 * so nothing has to touch the filesystem — worth noting on a serverless target,
 * where the filesystem is read-only anyway.
 *
 * Credentials come from the environment only. There are no fallback literals
 * here on purpose: a secret written into source is a published secret.
 */

const CLOUD_NAME = () => process.env.CLOUDINARY_CLOUD_NAME ?? "";
const API_KEY = () => process.env.CLOUDINARY_API_KEY ?? "";
const API_SECRET = () => process.env.CLOUDINARY_API_SECRET ?? "";

export function cloudinaryConfigured(): boolean {
  return Boolean(CLOUD_NAME() && API_KEY() && API_SECRET());
}

/**
 * Cloudinary's signature: the signed parameters sorted by key, joined as a
 * query string, with the API secret appended, then SHA-1.
 */
function sign(params: Record<string, string>): string {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(base + API_SECRET()).digest("hex");
}

/**
 * Account usage, straight from Cloudinary's `usage` endpoint.
 *
 * Authenticated with the api key and secret as HTTP Basic — the same secret
 * used for signing, no separate token. Every figure is "used" plus, on paid
 * plans, a "limit"; the free plan reports usage against a monthly credit pool
 * instead, so `limit` may be absent and the caller shows what it has.
 */
export type CloudinaryUsage = {
  plan: string;
  /** Stored bytes. */
  storageUsed: number;
  storageLimit?: number;
  /** Bytes delivered this cycle. */
  bandwidthUsed: number;
  bandwidthLimit?: number;
  /** Number of stored derived + original assets. */
  resources: number;
  /** Credit pool, when the plan is metered that way. */
  creditsUsed?: number;
  creditsLimit?: number;
};

export async function cloudinaryUsage(): Promise<CloudinaryUsage | null> {
  if (!cloudinaryConfigured()) return null;

  const auth = Buffer.from(`${API_KEY()}:${API_SECRET()}`).toString("base64");
  const { data } = await axios.get(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME()}/usage`,
    { headers: { Authorization: `Basic ${auth}` }, timeout: 10_000 }
  );

  return {
    plan: String(data?.plan ?? "unknown"),
    storageUsed: Number(data?.storage?.usage ?? 0),
    storageLimit: num(data?.storage?.limit),
    bandwidthUsed: Number(data?.bandwidth?.usage ?? 0),
    bandwidthLimit: num(data?.bandwidth?.limit),
    resources: Number(data?.resources ?? 0),
    creditsUsed: num(data?.credits?.usage),
    creditsLimit: num(data?.credits?.limit),
  };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type UploadResult = {
  url: string;
  /** Cloudinary's handle for the asset, needed to delete it later. */
  publicId: string;
};

/**
 * Upload an image and return its delivery URL.
 *
 * `file` is a data URL. `transformation` is applied at upload time rather than
 * on delivery so the stored asset is already the size we serve — an avatar has
 * exactly one shape, and there is no reason to keep the original around.
 */
export async function uploadImage(opts: {
  file: string;
  folder: string;
  publicId: string;
  transformation?: string;
}): Promise<UploadResult> {
  if (!cloudinaryConfigured()) throw new Error("cloudinary is not configured");

  const signed: Record<string, string> = {
    folder: opts.folder,
    public_id: opts.publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  if (opts.transformation) signed.transformation = opts.transformation;

  const form = new URLSearchParams({
    ...signed,
    signature: sign(signed),
    api_key: API_KEY(),
    file: opts.file,
  });

  const { data } = await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME()}/image/upload`,
    form,
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Generous: this carries the whole image in the body, and a slow upstream
      // shouldn't turn a working upload into a failed one.
      timeout: 30_000,
      // The image itself is already capped by the caller; this only stops a
      // surprising response body from being buffered without limit.
      maxBodyLength: 12 * 1024 * 1024,
    }
  );

  const url = String(data?.secure_url ?? "");
  if (!url) throw new Error("cloudinary returned no URL");

  return { url, publicId: String(data?.public_id ?? "") };
}

 
export async function deleteImage(publicId: string): Promise<void> {
  if (!cloudinaryConfigured() || !publicId) return;

  const signed = {
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  const form = new URLSearchParams({
    ...signed,
    signature: sign(signed),
    api_key: API_KEY(),
  });

  try {
    await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME()}/image/destroy`,
      form,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
    );
  } catch (e) {
    console.error("[cloudinary] delete failed:", e instanceof Error ? e.message : e);
  }
}

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export type ParsedDataUrl = { mime: string; bytes: number };

 
export function checkImageDataUrl(
  dataUrl: string,
  maxBytes: number
): { error: string } | ParsedDataUrl {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return { error: "expected a base64 image data URL" };

  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime))
    return { error: "image must be a PNG, JPEG, WebP or GIF" };

  const b64 = match[2];
  // Every 4 base64 characters encode 3 bytes, less any padding.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;

  if (bytes <= 0) return { error: "that image is empty" };
  if (bytes > maxBytes)
    return { error: `image must be ${Math.round(maxBytes / 1024)}KB or smaller` };

  return { mime, bytes };
}

 

export type ResourceKind = "image" | "video" | "raw";

export function resourceKind(mime: string): ResourceKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "video";
  return "raw";
}

 
export function cloudinaryPipelineFor(mime: string, kind: ResourceKind): ResourceKind {
  if (mime === "application/pdf") return "image";
  return kind;
}

export type AssetUploadResult = {
  url: string;
  publicId: string;
  kind: ResourceKind;
  pipeline: ResourceKind;
  bytes: number;
  format: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
};

/**
 * A preview of an asset, produced at delivery time.
 *
 * A transformation on the same URL rather than a second upload: the thumbnail
 * can never drift from the file it represents, and nothing extra is stored.
 * A video's first frame is asked for as a `.jpg`; `raw` has nothing to show.
 */
export function thumbnailFor(url: string, kind: ResourceKind, pipeline: ResourceKind = kind): string | undefined {
  if (pipeline === "raw") return undefined;

  const marker = "/upload/";
  const at = url.indexOf(marker);
  if (at === -1) return undefined;

  const transform = "c_fill,w_640,h_480,q_auto,f_auto/";
  const base = url.slice(0, at + marker.length) + transform + url.slice(at + marker.length);

  // A pdf's page still needs turning into a raster image, same as a video's
  // first frame — everything else in the image pipeline already is one.
  return kind === "video" || kind === "raw" ? base.replace(/\.[^./]+$/, ".jpg") : base;
}

/** Upload one library asset, of any kind. */
export async function uploadAsset(opts: {
  file: string;
  folder: string;
  publicId: string;
  kind: ResourceKind;
  mime: string;
}): Promise<AssetUploadResult> {
  if (!cloudinaryConfigured()) throw new Error("cloudinary is not configured");

  const pipeline = cloudinaryPipelineFor(opts.mime, opts.kind);

  const signed: Record<string, string> = {
    folder: opts.folder,
    public_id: opts.publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  const form = new URLSearchParams({
    ...signed,
    signature: sign(signed),
    api_key: API_KEY(),
    file: opts.file,
  });

  const { data } = await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME()}/${pipeline}/upload`,
    form,
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Longer than the avatar path's: a video is the reason this exists.
      timeout: 60_000,
      maxBodyLength: MAX_ASSET_BYTES * 2,
    }
  );

  const url = String(data?.secure_url ?? "");
  if (!url) throw new Error("cloudinary returned no URL");

  return {
    url,
    publicId: String(data?.public_id ?? ""),
    kind: opts.kind,
    pipeline,
    bytes: Number(data?.bytes ?? 0),
    format: String(data?.format ?? ""),
    width: typeof data?.width === "number" ? data.width : undefined,
    height: typeof data?.height === "number" ? data.height : undefined,
    thumbnailUrl: thumbnailFor(url, opts.kind, pipeline),
  };
}

/** Delete one asset from its own pipeline. Best-effort, like `deleteImage`. Pass the Cloudinary pipeline it was uploaded through, not its app-level kind. */
export async function deleteAsset(publicId: string, kind: ResourceKind): Promise<void> {
  if (!cloudinaryConfigured() || !publicId) return;

  const signed = {
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  const form = new URLSearchParams({
    ...signed,
    signature: sign(signed),
    api_key: API_KEY(),
  });

  try {
    await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME()}/${kind}/destroy`,
      form,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15_000 }
    );
  } catch (e) {
    console.error("[cloudinary] delete failed:", e instanceof Error ? e.message : e);
  }
}

 
export async function deleteAssets(publicIds: string[], kind: ResourceKind): Promise<void> {
  if (!cloudinaryConfigured()) return;

  const ids = publicIds.filter(Boolean);
  if (ids.length === 0) return;

  const auth = Buffer.from(`${API_KEY()}:${API_SECRET()}`).toString("base64");

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const query = batch.map((id) => `public_ids[]=${encodeURIComponent(id)}`).join("&");

    try {
      await axios.delete(
        `https://api.cloudinary.com/v1_1/${CLOUD_NAME()}/resources/${kind}/upload?${query}`,
        { headers: { Authorization: `Basic ${auth}` }, timeout: 30_000 }
      );
    } catch (e) {
      console.error("[cloudinary] batch delete failed:", e instanceof Error ? e.message : e);
    }
  }
}

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
 
const ALLOWED_ASSET_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
  "application/zip",
  "application/x-zip-compressed",
  // Word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Excel
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // PowerPoint
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Open Document formats
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
]);

/** `checkImageDataUrl`, widened to everything the library takes. */
export function checkAssetDataUrl(
  dataUrl: string,
  maxBytes: number = MAX_ASSET_BYTES
): { error: string } | ParsedDataUrl {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return { error: "expected a base64 data URL" };

  const mime = match[1].toLowerCase();
  if (!ALLOWED_ASSET_MIME.has(mime)) {
    return { error: `files of type "${mime}" are not supported` };
  }

  const b64 = match[2];
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;

  if (bytes <= 0) return { error: "that file is empty" };
  if (bytes > maxBytes) {
    return { error: `file must be ${Math.round(maxBytes / 1024 / 1024)}MB or smaller` };
  }

  return { mime, bytes };
}
