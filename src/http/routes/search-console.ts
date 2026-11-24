import { Router, Response } from "express";
import { SearchConsoleConnection } from "../../modules/seo/models/SearchConsoleConnection.js";
import { SearchConsoleProperty } from "../../modules/seo/models/SearchConsoleProperty.js";
import { SearchConsoleCache } from "../../modules/seo/models/SearchConsoleCache.js";
import {
  listSearchConsoleSites,
  missingSearchConsoleConfig,
} from "../../infra/http-client/search-console.js";
import { disconnectSearchConsole } from "../../modules/seo/search-console-connection.service.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  BREAKDOWN_DIMENSIONS,
  BREAKDOWN_SORTS,
  clampRange,
  clampType,
  clearSiteCache,
  explainSearchConsoleError,
  getSearchBreakdownPage,
  getSearchDrilldown,
  getSearchHourly,
  getSearchInsights,
  getSearchPerformance,
  getSearchSitemaps,
  isUsablePermission,
  propertyMatchesDomain,
  usableSearchConsoleToken,
  withGoogleSession,
  type BreakdownDimension,
  type BreakdownSort,
  type SearchSitemaps,
  type SiteRef,
} from "../../modules/seo/search-console.service.js";
import {
  explainSitemapWriteError,
  removeSitemap,
  sitemapAccess,
  SitemapWriteDenied,
  submitSitemap,
} from "../../modules/seo/search-sitemaps.service.js";
import { parseSearchFilters } from "../../modules/seo/search-filters.js";
import { checkNextPages, getSearchIndexing } from "../../modules/seo/search-indexing.service.js";
import { inspectPage } from "../../modules/seo/search-inspections.service.js";
import { clampDevice, getPageVitals, getWebVitals } from "../../modules/seo/web-vitals.service.js";
import type { WorkspaceRole } from "../../modules/workspace/models/Membership.js";
import { AppError, badRequest } from "../../shared/errors/index.js";
import {
  ensureSearchDays,
  ensureSearchInsights,
  searchEntitlement,
  SearchPlanDenied,
  type SearchEntitlement,
} from "../../modules/seo/search-entitlements.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";
import { isDenied, resolveAccess } from "../../modules/workspace/access.service.js";
import { resolveSite, siteRefused } from "./resolve-site.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

function googleFailure(res: Response, err: unknown) {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  const status = err instanceof GoogleApiError ? err.status : 502;
  return res.status(status).json({
    error: explainSearchConsoleError(err),
    kind: err instanceof GoogleApiError ? err.kind : "unknown",
  });
}

router.get(
  "/:wid/search-console",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "viewer");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const workspaceId = access.workspace.id;

    const configured = missingSearchConsoleConfig().length === 0;
    const [connection, links] = await Promise.all([
      SearchConsoleConnection.findOne({ workspaceId }),
      SearchConsoleProperty.find({ workspaceId }).select("siteId propertyUrl"),
    ]);

    res.json({
      configured,
      connected: Boolean(connection),
      connection: connection
        ? {
            googleEmail: connection.get("googleEmail") ?? "",
            status: connection.get("status"),
            statusMessage: connection.get("statusMessage") ?? "",
            connectedAt: connection.get("createdAt"),
          }
        : null,
      links: links.map((link) => ({
        siteId: link.get("siteId"),
        propertyUrl: link.get("propertyUrl"),
      })),
    });
  }),
);

router.delete(
  "/:wid/search-console",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "admin");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    await disconnectSearchConsole(access.workspace.id);

    res.json({ disconnected: true });
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/properties",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "admin");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const connection = await SearchConsoleConnection.findOne({ workspaceId: found.ws.id });
    if (!connection) return res.status(404).json({ error: "Search Console is not connected" });

    try {
      const connectionId = String(connection._id);
      const sites = await withGoogleSession(connectionId, async () =>
        listSearchConsoleSites(await usableSearchConsoleToken(connectionId)),
      );
      const domain = String(found.site.get("domain") ?? "");

      const properties = sites
        .filter((site) => isUsablePermission(site.permissionLevel))
        .map((site) => ({
          propertyUrl: site.siteUrl,
          permissionLevel: site.permissionLevel,
          matches: propertyMatchesDomain(site.siteUrl, domain),
        }))
        .sort((a, b) => Number(b.matches) - Number(a.matches) || a.propertyUrl.localeCompare(b.propertyUrl));

      res.json({ domain, properties });
    } catch (err) {
      googleFailure(res, err);
    }
  }),
);

router.put(
  "/:wid/sites/:siteId/search-console",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "admin");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const propertyUrl = String(req.body?.propertyUrl ?? "").trim();
    if (!propertyUrl) return res.status(400).json({ error: "propertyUrl is required" });

    const domain = String(found.site.get("domain") ?? "");
    if (!propertyMatchesDomain(propertyUrl, domain) && req.body?.allowMismatch !== true)
      return res.status(400).json({ error: `That property does not cover ${domain}` });

    const connection = await SearchConsoleConnection.findOne({ workspaceId: found.ws.id });
    if (!connection) return res.status(404).json({ error: "Search Console is not connected" });

    try {
      const connectionId = String(connection._id);
      const sites = await withGoogleSession(connectionId, async () =>
        listSearchConsoleSites(await usableSearchConsoleToken(connectionId)),
      );
      const match = sites.find(
        (site) => site.siteUrl === propertyUrl && isUsablePermission(site.permissionLevel),
      );
      if (!match)
        return res.status(403).json({
          error: "The connected Google account does not have access to that property",
        });

      await SearchConsoleProperty.findOneAndUpdate(
        { siteId: found.site.get("siteId") },
        {
          workspaceId: found.ws.id,
          siteId: found.site.get("siteId"),
          propertyUrl: match.siteUrl,
          permissionLevel: match.permissionLevel,
          linkedBy: req.userId,
        },
        { upsert: true, new: true },
      );
      await SearchConsoleCache.deleteMany({ siteId: found.site.get("siteId") });

      res.json({ siteId: found.site.get("siteId"), propertyUrl: match.siteUrl });
    } catch (err) {
      googleFailure(res, err);
    }
  }),
);

router.delete(
  "/:wid/sites/:siteId/search-console",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req, "admin");
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

    const siteId = found.site.get("siteId");
    await SearchConsoleProperty.deleteOne({ siteId });
    await SearchConsoleCache.deleteMany({ siteId });
    res.json({ unlinked: true });
  }),
);

async function linkedSite(
  req: AuthedRequest,
  res: Response,
  minimum: WorkspaceRole = "viewer",
): Promise<{ site: SiteRef; ent: SearchEntitlement } | null> {
  const found = await resolveSite(req, minimum);
  if (siteRefused(found)) {
    res.status(found.status).json({ error: found.error });
    return null;
  }

  const siteId = String(found.site.get("siteId"));
  const link = await SearchConsoleProperty.findOne({ siteId });
  if (!link) {
    res.status(404).json({ error: "No Search Console property is linked to this site" });
    return null;
  }

  const connection = await SearchConsoleConnection.findOne({ workspaceId: found.ws.id });
  if (!connection) {
    res.status(404).json({ error: "Search Console is not connected" });
    return null;
  }

  const ent = await searchEntitlement(String(found.ws.id));
  if (!ent) {
    planLimit(res, "This workspace has no active plan", { kind: "searchConsole", label: "Search visibility" }, "plan_required");
    return null;
  }

  return {
    ent,
    site: {
      workspaceId: String(found.ws.id),
      siteId,
      connectionId: String(connection._id),
      propertyUrl: String(link.get("propertyUrl")),
      domain: String(found.site.get("domain") ?? ""),
    },
  };
}

const FILTER_REFUSED =
  "Google didn't accept that filter. Check the pattern, or remove the filter if this property doesn't support it.";

function refusedFilter(req: AuthedRequest, err: unknown): boolean {
  return Boolean(req.query.filters) && err instanceof GoogleApiError && err.status === 400;
}

function searchRequest(req: AuthedRequest, ent: SearchEntitlement) {
  const type = clampType(req.query.type);
  return { days: daysFrom(req.query.days, ent), type, filters: parseSearchFilters(req.query.filters, type) };
}

function withLinkedSite(
  load: (site: SiteRef, req: AuthedRequest, ent: SearchEntitlement) => Promise<unknown>,
  minimum: WorkspaceRole = "viewer",
) {
  return asyncHandler(async (req: AuthedRequest, res: Response) => {
    const linked = await linkedSite(req, res, minimum);
    if (!linked) return;
    try {
      res.json(await withGoogleSession(linked.site.connectionId, () => load(linked.site, req, linked.ent)));
    } catch (err) {
      if (err instanceof SearchPlanDenied) return planLimit(res, err.message, err.limit, err.code);
      if (refusedFilter(req, err)) return res.status(400).json({ error: FILTER_REFUSED, kind: "filter" });
      googleFailure(res, err);
    }
  });
}

function daysFrom(value: unknown, ent: SearchEntitlement): number {
  const days = clampRange(value);
  ensureSearchDays(ent, days);
  return days;
}

router.get(
  "/:wid/sites/:siteId/search-console/performance",
  withLinkedSite((site, req, ent) => {
    const { days, type, filters } = searchRequest(req, ent);
    return getSearchPerformance(site, days, type, ent.pageViews, filters);
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/breakdown",
  withLinkedSite((site, req, ent) => {
    const dimension = String(req.query.dimension ?? "query") as BreakdownDimension;
    if (!BREAKDOWN_DIMENSIONS.includes(dimension)) throw badRequest("unknown dimension");
    const sort = String(req.query.sort ?? "clicks") as BreakdownSort;
    const { days, type, filters } = searchRequest(req, ent);
    return getSearchBreakdownPage(site, dimension, days, type, {
      page: Number(req.query.page ?? 1) || 1,
      pageSize: Number(req.query.pageSize ?? 50) || 50,
      sort: BREAKDOWN_SORTS.includes(sort) ? sort : "clicks",
      desc: req.query.dir !== "asc",
      q: String(req.query.q ?? "").slice(0, 200),
      rowLimit: dimension === "device" || dimension === "searchAppearance" ? null : ent.rowLimit,
      withViews: ent.pageViews,
      filters,
    });
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/insights",
  withLinkedSite((site, req, ent) => {
    ensureSearchInsights(ent);
    const { days, type, filters } = searchRequest(req, ent);
    return getSearchInsights(site, days, type, ent.insightRows, filters);
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/drilldown",
  withLinkedSite(async (site, req, ent) => {
    const dimension = String(req.query.dimension ?? "");
    const value = String(req.query.value ?? "").slice(0, 2048);
    if (dimension !== "query" && dimension !== "page") throw badRequest("dimension must be query or page");
    if (!value) throw badRequest("value is required");
    const { days, type, filters } = searchRequest(req, ent);
    const drill = await getSearchDrilldown(site, dimension, value, days, type, filters);
    return ent.pageViews ? drill : { ...drill, views: undefined };
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/inspection",
  withLinkedSite(async (site, req, ent) => {
    const url = String(req.query.url ?? "").slice(0, 2048);
    if (!url) throw badRequest("url is required");
    return inspectPage(site, ent, url);
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/indexing",
  withLinkedSite((site, _req, ent) => getSearchIndexing(site, ent)),
);

router.post(
  "/:wid/sites/:siteId/search-console/indexing/check",
  withLinkedSite((site, req, ent) => checkNextPages(site, ent, Number(req.body?.count) || 10), "editor"),
);

router.get(
  "/:wid/sites/:siteId/search-console/hourly",
  withLinkedSite((site, req) => {
    const type = clampType(req.query.type);
    return getSearchHourly(site, type, parseSearchFilters(req.query.filters, type));
  }),
);

router.get(
  "/:wid/sites/:siteId/search-console/vitals",
  withLinkedSite((site, req) => getWebVitals(site, clampDevice(req.query.device))),
);

router.get(
  "/:wid/sites/:siteId/search-console/vitals/pages",
  withLinkedSite((site, req, ent) =>
    getPageVitals(site, clampDevice(req.query.device), clampRange(Math.min(28, ent.maxDays))),
  ),
);

router.get(
  "/:wid/sites/:siteId/search-console/sitemaps",
  withLinkedSite(async (site) => {
    const [sitemaps, access] = await Promise.all([getSearchSitemaps(site), sitemapAccess(site)]);
    return { ...sitemaps, access };
  }),
);

function sitemapWrite(
  write: (site: SiteRef, value: unknown) => Promise<SearchSitemaps>,
  pick: (req: AuthedRequest) => unknown,
) {
  return asyncHandler(async (req: AuthedRequest, res: Response) => {
    const linked = await linkedSite(req, res, "admin");
    if (!linked) return;
    try {
      const result = await withGoogleSession(linked.site.connectionId, async () => {
        const sitemaps = await write(linked.site, pick(req));
        return { ...sitemaps, access: await sitemapAccess(linked.site) };
      });
      res.json(result);
    } catch (err) {
      if (err instanceof SitemapWriteDenied) {
        return res.status(403).json({ error: err.message, kind: `sitemap_${err.blockedBy}` });
      }
      if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
      const status = err instanceof GoogleApiError ? err.status : 502;
      res.status(status).json({
        error: explainSitemapWriteError(err),
        kind: err instanceof GoogleApiError ? err.kind : "unknown",
      });
    }
  });
}

router.post(
  "/:wid/sites/:siteId/search-console/sitemaps",
  sitemapWrite(submitSitemap, (req) => req.body?.url),
);

router.delete(
  "/:wid/sites/:siteId/search-console/sitemaps",
  sitemapWrite(removeSitemap, (req) => req.query.url),
);

router.post(
  "/:wid/sites/:siteId/search-console/refresh",
  withLinkedSite(async (site, req, ent) => {
    const days = daysFrom(req.body?.days, ent);
    await clearSiteCache(site.siteId);
    return getSearchPerformance(site, days, clampType(req.body?.type), ent.pageViews);
  }),
);

export default router;