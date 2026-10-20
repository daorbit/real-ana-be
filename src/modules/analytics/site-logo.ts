import { checkImageDataUrl, uploadImage } from "../../infra/storage/cloudinary.js";

const MAX_LOGO_URL = 500;
export const MAX_SITE_LOGO_BYTES = 2 * 1024 * 1024;

export function parseSiteLogoUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > MAX_LOGO_URL) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function uploadSiteLogo(workspaceId: string, dataUrl: string): Promise<{ url: string } | { error: string }> {
  const checked = checkImageDataUrl(dataUrl, MAX_SITE_LOGO_BYTES);
  if ("error" in checked) return { error: checked.error };

  const { url } = await uploadImage({
    file: dataUrl,
    folder: "quantalog-site-logos",
    publicId: `site-logo-${workspaceId}-${Date.now()}`,
    transformation: "c_limit,h_256,w_256/q_auto",
  });
  return { url };
}
