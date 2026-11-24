import { Site } from "../analytics/models/Site.js";
import { parseSiteLogoUrl } from "../analytics/site-logo.js";
import { ROLE_RANK, type WorkspaceRole } from "../workspace/models/Membership.js";
import { resolveBranding, saveBranding } from "./branding.service.js";

function normalized(url: string | null | undefined): string {
  return parseSiteLogoUrl(url?.trim()) || "";
}

function follows(current: string | null | undefined, previous: string | null | undefined): boolean {
  return !current?.trim() || normalized(current) === normalized(previous);
}

export async function syncSiteLogoToBrand(change: {
  workspaceId: string;
  role: WorkspaceRole;
  previous?: string;
  next: string;
}): Promise<boolean> {
  const { workspaceId, role, previous, next } = change;
  if (!next || next === previous || ROLE_RANK[role] < ROLE_RANK.admin) return false;

  const [branding, sites] = await Promise.all([resolveBranding(workspaceId), Site.countDocuments({ workspaceId })]);
  if (sites !== 1 || !branding.editable || !follows(branding.stored.logoUrl, previous)) return false;

  await saveBranding(workspaceId, { logoUrl: next });
  return true;
}

export async function syncBrandLogoToSite(change: {
  workspaceId: string;
  previous?: string;
  next?: string;
}): Promise<void> {
  const { workspaceId, previous } = change;
  const next = normalized(change.next);
  if (!next || next === normalized(previous)) return;

  const sites = await Site.find({ workspaceId }).select("logoUrl").limit(2).lean<{ _id: unknown; logoUrl?: string }[]>();
  if (sites.length !== 1 || !follows(sites[0].logoUrl, previous)) return;

  await Site.updateOne({ _id: sites[0]._id }, { $set: { logoUrl: next } });
}
