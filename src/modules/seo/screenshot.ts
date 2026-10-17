import sharp from "sharp";

const MAX_HEIGHT = { desktop: 2400, mobile: 2600 } as const;
const WEBP_QUALITY = 82;
const MAX_DATA_URL_LENGTH = 450_000;
const FINGERPRINT = { width: 48, height: 32 };
const MAX_VIEWPORT_DIFF = 20;

export type RawScreenshots = {
  full?: string;
  final?: string;
};

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

function decode(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

function fingerprint(image: ReturnType<typeof sharp>): Promise<Buffer> {
  return image.resize(FINGERPRINT.width, FINGERPRINT.height, { fit: "fill" }).greyscale().raw().toBuffer();
}

async function fullMatchesViewport(full: Buffer, final: Buffer): Promise<boolean> {
  const [fullMeta, finalMeta] = await Promise.all([sharp(full).metadata(), sharp(final).metadata()]);
  if (!fullMeta.width || !fullMeta.height || !finalMeta.width || !finalMeta.height) return false;

  const viewportHeight = Math.min(
    fullMeta.height,
    Math.round((fullMeta.width * finalMeta.height) / finalMeta.width),
  );
  const [top, viewport] = await Promise.all([
    fingerprint(sharp(full).extract({ left: 0, top: 0, width: fullMeta.width, height: viewportHeight })),
    fingerprint(sharp(final)),
  ]);

  let diff = 0;
  for (let i = 0; i < top.length; i += 1) diff += Math.abs(top[i] - viewport[i]);
  return diff / top.length <= MAX_VIEWPORT_DIFF;
}

async function cropFullPage(full: Buffer, strategy: keyof typeof MAX_HEIGHT): Promise<string | null> {
  const image = sharp(full);
  const { width, height } = await image.metadata();
  if (!width || !height) return null;

  const output = await image
    .extract({ left: 0, top: 0, width, height: Math.min(height, MAX_HEIGHT[strategy]) })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  const url = `data:image/webp;base64,${output.toString("base64")}`;
  return url.length <= MAX_DATA_URL_LENGTH ? url : null;
}

export async function previewScreenshot(
  raw: RawScreenshots,
  strategy: keyof typeof MAX_HEIGHT,
): Promise<string | null> {
  const final = isImageDataUrl(raw.final) && raw.final.length <= MAX_DATA_URL_LENGTH ? raw.final : null;
  if (!isImageDataUrl(raw.full)) return final;

  try {
    const full = decode(raw.full);
    if (final && !(await fullMatchesViewport(full, decode(final)))) return final;
    return (await cropFullPage(full, strategy)) ?? final;
  } catch (err) {
    console.warn(`[seo] ${strategy} screenshot processing failed:`, err instanceof Error ? err.message : err);
    return final;
  }
}
