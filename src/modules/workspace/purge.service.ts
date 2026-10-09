import { Workspace } from "./models/Workspace.js";
import { Membership } from "./models/Membership.js";
import { WorkspaceInvite } from "./models/WorkspaceInvite.js";
import { Project } from "./models/Project.js";
import { Site } from "../analytics/models/Site.js";
import { Event } from "../analytics/models/Event.js";
import { HeatmapClick } from "../analytics/models/HeatmapClick.js";
import { Funnel } from "../analytics/models/Funnel.js";
import { Segment } from "../analytics/models/Segment.js";
import { Marker } from "../analytics/models/Marker.js";
import { SeoReport } from "../seo/models/SeoReport.js";
import { Competitor } from "../seo/models/Competitor.js";
import { CompetitorSnapshot } from "../seo/models/CompetitorSnapshot.js";
import { CrawlReport } from "../seo/models/CrawlReport.js";
import { SearchConsoleProperty } from "../seo/models/SearchConsoleProperty.js";
import { SearchConsoleCache } from "../seo/models/SearchConsoleCache.js";
import { Backlink } from "../backlinks/models/Backlink.js";
import { CompetitorBacklink } from "../backlinks/models/CompetitorBacklink.js";
import { ApiKey } from "../identity/models/ApiKey.js";
import { ApiKeyUsage } from "../identity/models/ApiKeyUsage.js";
import { Subscription } from "../billing/models/Subscription.js";
import { UsageMonth } from "../billing/models/UsageMonth.js";
import { ReportSchedule } from "../reports/models/ReportSchedule.js";
import { ScheduledPost } from "../social/models/ScheduledPost.js";
import { SocialPostRun } from "../social/models/SocialPostRun.js";
import { Branding } from "../branding/models/Branding.js";
import { Notification } from "../notifications/models/Notification.js";
import { OrbitConversation } from "../orbit-history/models/OrbitConversation.js";
import { OrbitMessage } from "../orbit-history/models/OrbitMessage.js";
import { invalidateSite } from "../billing/event-quota.js";
import { deleteWorkspaceDashboards } from "../dashboards/cleanup.js";
import { deleteWorkspaceMedia } from "../media/cleanup.js";
import { deleteWorkspaceNavLogos } from "./nav-prefs.service.js";
import { disconnectGoogleReviews } from "../reviews/connection.service.js";
import { disconnectSearchConsole } from "../seo/search-console-connection.service.js";
import { purgeFormsWorkspace } from "../../infra/http-client/forms-service.js";

async function purgeSiteData(siteIds: string[]): Promise<void> {
  if (!siteIds.length) return;
  const bySite = { siteId: { $in: siteIds } };

  await Promise.all([
    Event.deleteMany(bySite),
    HeatmapClick.deleteMany(bySite),
    SeoReport.deleteMany(bySite),
    Competitor.deleteMany(bySite),
    CompetitorSnapshot.deleteMany(bySite),
    CompetitorBacklink.deleteMany(bySite),
    CrawlReport.deleteMany(bySite),
    Backlink.deleteMany(bySite),
    SearchConsoleProperty.deleteMany(bySite),
    SearchConsoleCache.deleteMany(bySite),
  ]);
}

export async function purgeSite(siteId: string): Promise<void> {
  await purgeSiteData([siteId]);
  await Site.deleteOne({ siteId });
  invalidateSite(siteId);
}

export async function purgeWorkspaces(workspaceIds: string[]): Promise<void> {
  if (!workspaceIds.length) return;
  const byWorkspace = { workspaceId: { $in: workspaceIds } };

  await Promise.all(workspaceIds.map((id) => purgeFormsWorkspace(id)));

  const sites = await Site.find(byWorkspace).select("siteId").lean();
  const siteIds = sites.map((s) => s.siteId as string);

  await Promise.all([
    purgeSiteData(siteIds),
    deleteWorkspaceMedia(workspaceIds),
    deleteWorkspaceNavLogos(workspaceIds),
    ...workspaceIds.flatMap((id) => [
      disconnectGoogleReviews(id),
      disconnectSearchConsole(id),
      deleteWorkspaceDashboards(id),
    ]),
    Funnel.deleteMany(byWorkspace),
    Segment.deleteMany(byWorkspace),
    Marker.deleteMany(byWorkspace),
    Project.deleteMany(byWorkspace),
    ApiKey.deleteMany(byWorkspace),
    ApiKeyUsage.deleteMany(byWorkspace),
    UsageMonth.deleteMany(byWorkspace),
    ReportSchedule.deleteMany(byWorkspace),
    ScheduledPost.deleteMany(byWorkspace),
    SocialPostRun.deleteMany(byWorkspace),
    Branding.deleteMany(byWorkspace),
    Notification.deleteMany(byWorkspace),
    OrbitConversation.deleteMany(byWorkspace),
    OrbitMessage.deleteMany(byWorkspace),
    SeoReport.deleteMany(byWorkspace),
    Competitor.deleteMany(byWorkspace),
    CrawlReport.deleteMany(byWorkspace),
    Backlink.deleteMany(byWorkspace),
    CompetitorBacklink.deleteMany(byWorkspace),
    WorkspaceInvite.deleteMany(byWorkspace),
  ]);

  await Site.deleteMany(byWorkspace);

  await Promise.all([
    Subscription.deleteMany(byWorkspace),
    Membership.deleteMany(byWorkspace),
    Workspace.deleteMany({ _id: { $in: workspaceIds } }),
  ]);

  for (const id of siteIds) invalidateSite(id);
}
