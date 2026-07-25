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

/**
 * Delete an asset. Best-effort by design: the caller has usually already
 * replaced the reference, so a failure here leaves an orphaned file rather than
 * a broken profile, and is not worth failing the request over.
 */
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

/** Formats Cloudinary accepts and browsers render. SVG is excluded: it can carry script. */
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export type ParsedDataUrl = { mime: string; bytes: number };

/**
 * Validate a base64 image data URL without decoding the whole thing twice.
 *
 * Returns a string describing the problem, or the parsed metadata. Size is
 * checked from the base64 length rather than by allocating the buffer, so an
 * oversized payload is refused before it costs memory.
 */
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
