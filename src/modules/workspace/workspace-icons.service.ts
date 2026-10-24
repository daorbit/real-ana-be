import { Branding } from "../branding/models/Branding.js";
import { Site } from "../analytics/models/Site.js";

export type WorkspaceIcon = { logoUrl: string | null; brandLogoUrl: string | null };

const SITES_PER_WORKSPACE = 25;

export const EMPTY_WORKSPACE_ICON: WorkspaceIcon = { logoUrl: null, brandLogoUrl: null };

function cleanUrl(raw: string | undefined): string | null {
  const url = (raw ?? "").trim();
  return /^https:\/\//i.test(url) ? url : null;
}

export async function workspaceIcons(ids: string[]): Promise<Map<string, WorkspaceIcon>> {
  const icons = new Map<string, WorkspaceIcon>();
  if (!ids.length) return icons;

  const [brands, sites] = await Promise.all([
    Branding.find({ workspaceId: { $in: ids }, logoUrl: { $nin: [null, ""] } })
      .select("workspaceId logoUrl")
      .lean<{ workspaceId: unknown; logoUrl?: string }[]>(),
    Site.find({ workspaceId: { $in: ids }, logoUrl: { $nin: [null, ""] } })
      .select("workspaceId logoUrl")
      .sort({ createdAt: 1 })
      .limit(ids.length * SITES_PER_WORKSPACE)
      .lean<{ workspaceId: unknown; logoUrl?: string }[]>(),
  ]);

  for (const brand of brands) {
    const logoUrl = cleanUrl(brand.logoUrl);
    if (logoUrl) icons.set(String(brand.workspaceId), { logoUrl, brandLogoUrl: logoUrl });
  }

  for (const site of sites) {
    const id = String(site.workspaceId);
    if (icons.has(id)) continue;
    const logoUrl = cleanUrl(site.logoUrl);
    if (logoUrl) icons.set(id, { logoUrl, brandLogoUrl: null });
  }

  return icons;
}
