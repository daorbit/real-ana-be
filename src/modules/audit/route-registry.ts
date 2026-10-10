import { isValidObjectId, type Model } from "mongoose";
import type { AuditAction } from "./actions.js";
import { GoalTarget } from "../dashboards/models/GoalTarget.js";
import { Dashboard } from "../dashboards/models/Dashboard.js";
import { Embed } from "../dashboards/models/Embed.js";
import { ReportSchedule } from "../reports/models/ReportSchedule.js";
import { Segment } from "../analytics/models/Segment.js";
import { Marker } from "../analytics/models/Marker.js";
import { Funnel } from "../analytics/models/Funnel.js";
import { Media } from "../media/models/Media.js";
import { Competitor } from "../seo/models/Competitor.js";
import { Backlink } from "../backlinks/models/Backlink.js";
import { SeoReport } from "../seo/models/SeoReport.js";

type Params = Record<string, string>;
type Snapshot = (workspaceId: string, params: Params) => Promise<string | undefined>;

export type RouteRule = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: RegExp;
  action: AuditAction | null;
  kind?: string;
  snapshot?: Snapshot;
  meta?: (body: Record<string, unknown>) => Record<string, unknown>;
};

type Named = { name?: unknown; label?: unknown; title?: unknown; url?: unknown; sourceUrl?: unknown } | null;

function pick(doc: Named): string | undefined {
  if (!doc) return undefined;
  const value = doc.name || doc.label || doc.title || doc.url || doc.sourceUrl;
  return typeof value === "string" && value ? value : undefined;
}

type AnyModel = Model<any>;

function byWorkspace(model: AnyModel, fields: string): Snapshot {
  return async (workspaceId, params) => {
    if (!isValidObjectId(params.id)) return undefined;
    return pick((await model.findOne({ _id: params.id, workspaceId }).select(fields).lean()) as Named);
  };
}

function bySite(model: AnyModel, fields: string): Snapshot {
  return async (_workspaceId, params) => {
    if (!isValidObjectId(params.id)) return undefined;
    return pick((await model.findOne({ _id: params.id, siteId: params.siteId }).select(fields).lean()) as Named);
  };
}

const ID = "(?<id>[^/]+)";
const SITE = "/sites/(?<siteId>[^/]+)";
const route = (path: string) => new RegExp(`^${path}/?$`);

export const ROUTE_RULES: RouteRule[] = [
  { method: "POST", pattern: route("/targets"), action: "goal.created", kind: "goal" },
  { method: "PUT", pattern: route(`/targets/${ID}`), action: "goal.updated", kind: "goal" },
  { method: "DELETE", pattern: route(`/targets/${ID}`), action: "goal.deleted", kind: "goal", snapshot: byWorkspace(GoalTarget, "name") },

  { method: "POST", pattern: route("/dashboards"), action: "dashboard.created", kind: "dashboard" },
  { method: "PATCH", pattern: route(`/dashboards/${ID}`), action: "dashboard.updated", kind: "dashboard", snapshot: byWorkspace(Dashboard, "name") },
  { method: "POST", pattern: route(`/dashboards/${ID}/duplicate`), action: "dashboard.duplicated", kind: "dashboard" },
  { method: "DELETE", pattern: route(`/dashboards/${ID}`), action: "dashboard.deleted", kind: "dashboard", snapshot: byWorkspace(Dashboard, "name") },

  { method: "POST", pattern: route("/embeds"), action: "embed.created", kind: "embed" },
  { method: "PATCH", pattern: route(`/embeds/${ID}`), action: "embed.updated", kind: "embed", snapshot: byWorkspace(Embed, "name") },
  { method: "DELETE", pattern: route(`/embeds/${ID}`), action: "embed.deleted", kind: "embed", snapshot: byWorkspace(Embed, "name") },

  { method: "POST", pattern: route("/reports"), action: "report.created", kind: "report" },
  { method: "PUT", pattern: route(`/reports/${ID}`), action: "report.updated", kind: "report", snapshot: byWorkspace(ReportSchedule, "name") },
  { method: "DELETE", pattern: route(`/reports/${ID}`), action: "report.deleted", kind: "report", snapshot: byWorkspace(ReportSchedule, "name") },
  { method: "POST", pattern: route(`/reports/${ID}/test`), action: "report.test_sent", kind: "report", snapshot: byWorkspace(ReportSchedule, "name") },
  { method: "POST", pattern: route(`/reports/${ID}/test-whatsapp`), action: "report.test_sent", kind: "report", snapshot: byWorkspace(ReportSchedule, "name") },

  { method: "POST", pattern: route("/segments"), action: "segment.created", kind: "segment" },
  { method: "PATCH", pattern: route(`/segments/${ID}`), action: "segment.updated", kind: "segment", snapshot: byWorkspace(Segment, "name") },
  { method: "DELETE", pattern: route(`/segments/${ID}`), action: "segment.deleted", kind: "segment", snapshot: byWorkspace(Segment, "name") },

  { method: "POST", pattern: route("/markers"), action: "marker.created", kind: "marker" },
  { method: "PATCH", pattern: route(`/markers/${ID}`), action: "marker.updated", kind: "marker", snapshot: byWorkspace(Marker, "label") },
  { method: "DELETE", pattern: route(`/markers/${ID}`), action: "marker.deleted", kind: "marker", snapshot: byWorkspace(Marker, "label") },

  { method: "POST", pattern: route("/funnel"), action: null },
  { method: "POST", pattern: route("/funnels"), action: "funnel.created", kind: "funnel" },
  { method: "PUT", pattern: route("/funnels/(?<id>[^/]+)"), action: "funnel.updated", kind: "funnel", snapshot: byWorkspace(Funnel, "name") },
  { method: "DELETE", pattern: route("/funnels/(?<id>[^/]+)"), action: "funnel.deleted", kind: "funnel", snapshot: byWorkspace(Funnel, "name") },

  { method: "POST", pattern: route("/media"), action: "media.uploaded", kind: "media" },
  { method: "PATCH", pattern: route(`/media/${ID}`), action: "media.renamed", kind: "media", snapshot: byWorkspace(Media, "name") },
  { method: "DELETE", pattern: route(`/media/${ID}`), action: "media.deleted", kind: "media", snapshot: byWorkspace(Media, "name") },
  {
    method: "POST",
    pattern: route("/media/bulk-delete"),
    action: "media.bulk_deleted",
    kind: "media",
    meta: (body) => ({ count: Array.isArray(body.ids) ? body.ids.length : 0 }),
  },

  { method: "PUT", pattern: route("/branding"), action: "branding.updated", kind: "branding" },
  { method: "PUT", pattern: route("/nav"), action: "sidebar.updated", kind: "sidebar" },
  { method: "POST", pattern: route("/nav/links/[^/]+/logo"), action: "sidebar.updated", kind: "sidebar" },
  { method: "DELETE", pattern: route("/nav/links/[^/]+/logo"), action: "sidebar.updated", kind: "sidebar" },

  { method: "PUT", pattern: route("/layout"), action: null },
  { method: "PUT", pattern: route("/theme"), action: null },
  { method: "POST", pattern: route("/onboarding-ai/copy"), action: null },
  { method: "POST", pattern: route("/forms-token"), action: null },
  { method: "POST", pattern: /^\/share\/(caption|plan|plan-image)\/?$/, action: null },

  { method: "POST", pattern: route(`${SITE}/seo/analyze`), action: "seo.audit_run", kind: "seo" },
  { method: "POST", pattern: route(`${SITE}/seo/crawl`), action: "seo.crawl_run", kind: "seo" },
  { method: "DELETE", pattern: route(`${SITE}/seo/reports/${ID}`), action: "seo.report_deleted", kind: "seo", snapshot: bySite(SeoReport, "url") },
  { method: "PUT", pattern: route(`${SITE}/seo/reports/${ID}/share`), action: "seo.report_shared", kind: "seo", snapshot: bySite(SeoReport, "url") },

  { method: "POST", pattern: route(`${SITE}/seo/competitors`), action: "competitor.added", kind: "competitor" },
  { method: "POST", pattern: route(`${SITE}/seo/competitors/refresh-all`), action: null },
  { method: "POST", pattern: route(`${SITE}/seo/competitors/[^/]+/(refresh|brief)`), action: null },
  { method: "DELETE", pattern: route(`${SITE}/seo/competitors/${ID}`), action: "competitor.removed", kind: "competitor", snapshot: bySite(Competitor, "label url") },

  { method: "POST", pattern: new RegExp(`^${SITE}/backlinks/`), action: null },
  { method: "DELETE", pattern: route(`${SITE}/backlinks/${ID}`), action: "backlink.removed", kind: "backlink", snapshot: bySite(Backlink, "sourceUrl") },

  { method: "DELETE", pattern: route("/search-console"), action: "search_console.disconnected", kind: "search_console" },
  { method: "PUT", pattern: route(`${SITE}/search-console`), action: "search_console.linked", kind: "search_console" },
  { method: "DELETE", pattern: route(`${SITE}/search-console`), action: "search_console.unlinked", kind: "search_console" },
  { method: "POST", pattern: route(`${SITE}/search-console/sitemaps`), action: "sitemap.submitted", kind: "sitemap" },
  { method: "DELETE", pattern: route(`${SITE}/search-console/sitemaps`), action: "sitemap.removed", kind: "sitemap" },
  { method: "POST", pattern: route(`${SITE}/search-console/refresh`), action: null },
];

export const SKIPPED_PREFIXES = ["/orbit", "/audit"];

export function matchRoute(method: string, path: string): { rule: RouteRule; params: Params } | null {
  for (const rule of ROUTE_RULES) {
    if (rule.method !== method) continue;
    const match = rule.pattern.exec(path);
    if (match) return { rule, params: { ...(match.groups ?? {}) } };
  }
  return null;
}
