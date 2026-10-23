import { Branding } from "../branding/models/Branding.js";
import { Site } from "../analytics/models/Site.js";

export type WorkspaceIcon = { logoUrl: string | null; domain: string | null };

const SITES_PER_WORKSPACE = 25;

export const EMPTY_WORKSPACE_ICON: WorkspaceIcon = { logoUrl: null, domain: null };

function cleanDomain(raw: string | undefined): string | null {
  const host = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
  return host || null;
}

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
    Site.find({ workspaceId: { $in: ids }, platform: "web" })
      .select("workspaceId domain logoUrl")
      .sort({ createdAt: 1 })
      .limit(ids.length * SITES_PER_WORKSPACE)
      .lean<{ workspaceId: unknown; domain?: string; logoUrl?: string }[]>(),
  ]);

  const brandLogo = new Map(brands.map((b) => [String(b.workspaceId), cleanUrl(b.logoUrl)]));

  for (const site of sites) {
    const id = String(site.workspaceId);
    if (icons.has(id)) continue;
    icons.set(id, {
      logoUrl: brandLogo.get(id) ?? cleanUrl(site.logoUrl),
      domain: cleanDomain(site.domain),
    });
  }

  for (const id of ids) {
    if (!icons.has(id)) icons.set(id, { logoUrl: brandLogo.get(id) ?? null, domain: null });
  }

  return icons;
}
