import sharp from "sharp";

const MAX_HEIGHT = { desktop: 2400, mobile: 2600 } as const;
const WEBP_QUALITY = 82;
const MAX_DATA_URL_LENGTH = 450_000;

export type RawScreenshots = {
  full?: string;
  final?: string;
};

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

async function cropFullPage(dataUrl: string, strategy: keyof typeof MAX_HEIGHT): Promise<string | null> {
  const input = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const image = sharp(input);
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
  if (isImageDataUrl(raw.full)) {
    try {
      const cropped = await cropFullPage(raw.full, strategy);
      if (cropped) return cropped;
    } catch (err) {
      console.warn(`[seo] ${strategy} screenshot crop failed:`, err instanceof Error ? err.message : err);
    }
  }
  return isImageDataUrl(raw.final) && raw.final.length <= MAX_DATA_URL_LENGTH ? raw.final : null;
}
