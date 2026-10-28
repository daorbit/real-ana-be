import { checkImageDataUrl } from "../../infra/storage/cloudinary.js";
import { extractDocumentText } from "../orbit/document.js";
import type { OrbitAttachment } from "./draft.js";

export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const PDF_DATA_URL = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/i;

export type AttachmentResult = { ok: true; attachment: OrbitAttachment } | { ok: false; error: string };

export async function readAttachment(raw: unknown): Promise<AttachmentResult> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, attachment: null };
  if (typeof raw !== "string") return { ok: false, error: "Attach a photo or a PDF." };

  const pdf = PDF_DATA_URL.exec(raw);
  if (pdf) {
    const buffer = Buffer.from(pdf[1], "base64");
    if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return { ok: false, error: "The PDF must be 6 MB or smaller." };
    const extracted = await extractDocumentText(buffer, "application/pdf");
    if (!extracted.ok) return { ok: false, error: "That PDF has no readable text. Attach a photo of it instead." };
    return { ok: true, attachment: { text: extracted.text } };
  }

  const checked = checkImageDataUrl(raw, MAX_ATTACHMENT_BYTES);
  if ("error" in checked) return { ok: false, error: "Attach a PNG, JPEG or WebP photo, or a PDF, up to 6 MB." };
  return { ok: true, attachment: { image: raw.slice(raw.indexOf(",") + 1) } };
}
