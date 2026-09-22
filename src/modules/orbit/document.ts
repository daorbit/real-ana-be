import mammoth from "mammoth";

export const SUPPORTED_DOCUMENT_MIME = new Set([
  "application/pdf",
  "text/csv",
  "application/vnd.ms-excel",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const MAX_EXTRACTED_CHARS = 20_000;

export type ExtractedDocument =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

function clip(text: string): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_EXTRACTED_CHARS) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, MAX_EXTRACTED_CHARS), truncated: true };
}

async function extractPdf(buffer: Buffer): Promise<string> {

  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function extractDocumentText(
  buffer: Buffer,
  mime: string,
): Promise<ExtractedDocument> {
  try {
    let raw: string;
    if (mime === "application/pdf") {
      raw = await extractPdf(buffer);
    } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      raw = await extractDocx(buffer);
    } else {
      raw = buffer.toString("utf8");
    }

    if (!raw.trim()) return { ok: false, error: "That file has no readable text in it." };

    const { text, truncated } = clip(raw);
    return { ok: true, text, truncated };
  } catch {
    return { ok: false, error: "Couldn't read that file. Try a different one." };
  }
}
