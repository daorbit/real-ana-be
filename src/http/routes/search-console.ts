import { Router, Response } from "express";
import { SearchConsoleConnection } from "../../modules/seo/models/SearchConsoleConnection.js";
import { SearchConsoleProperty } from "../../modules/seo/models/SearchConsoleProperty.js";
import { SearchConsoleCache } from "../../modules/seo/models/SearchConsoleCache.js";
import {
  listSearchConsoleSites,
  missingSearchConsoleConfig,
  revokeSearchConsoleToken,
} from "../../infra/http-client/search-console.js";
import { GoogleApiError } from "../../infra/http-client/google-oauth.js";
import {
  clampRange,
  explainSearchConsoleError,
  getSearchPerformance,
  isUsablePermission,
  propertyMatchesDomain,
  usableSearchConsoleToken,
} from "../../modules/seo/search-console.service.js";
import { currentPlan } from "../../modules/billing/quota.service.js";
import { decryptSecret } from "../../shared/utils/crypto-box.js";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { planLimit } from "../plan-limit.js";
import { isDenied, resolveAccess } from "../../modules/workspace/access.service.js";
import { resolveSite, siteRefused } from "./resolve-site.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

function googleFailure(res: Response, err: unknown) {
  const status = err instanceof GoogleApiError ? err.status : 502;
  return res.status(status).json({
    error: explainSearchConsoleError(err),
    kind: err instanceof GoogleApiError ? err.kind : "unknown",
  });
}

async function requirePaid(res: Response, workspaceId: string): Promise<boolean> {
  const plan = await currentPlan(workspaceId);
  if (plan && plan.slug !== "free") return true;
  planLimit(
    res,
    "Search Console needs this workspace on a paid plan",
    { kind: "searchConsole", label: "Search Console", plan: plan?.name },
    "plan_required",
  );
  return false;
}

router.get(
  "/:wid/search-console",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const access = await resolveAccess(req, "viewer");
    if (isDenied(access)) return res.status(access.status).json({ error: access.error });
    const workspaceId = access.workspace.id;

    const configured = missingSearchConsoleConfig().length === 0;
    const connection = await SearchConsoleConnection.findOne({ workspaceId });
    const links = await SearchConsoleProperty.find({ workspaceId }).select("siteId propertyUrl");

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
    const workspaceId = access.workspace.id;

    const connection = await SearchConsoleConnection.findOne({ workspaceId }).select("+refreshToken");
    if (connection) {
      const refreshToken = decryptSecret(String(connection.get("refreshToken") ?? ""));
      if (refreshToken) await revokeSearchConsoleToken(refreshToken);
    }

    await SearchConsoleCache.deleteMany({ workspaceId });
    await SearchConsoleProperty.deleteMany({ workspaceId });
    await SearchConsoleConnection.deleteOne({ workspaceId });

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
      const accessToken = await usableSearchConsoleToken(String(connection._id));
      const sites = await listSearchConsoleSites(accessToken);
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
    if (!(await requirePaid(res, found.ws.id))) return;

    const propertyUrl = String(req.body?.propertyUrl ?? "").trim();
    if (!propertyUrl) return res.status(400).json({ error: "propertyUrl is required" });

    const domain = String(found.site.get("domain") ?? "");
    if (!propertyMatchesDomain(propertyUrl, domain))
      return res.status(400).json({ error: `That property does not cover ${domain}` });

    const connection = await SearchConsoleConnection.findOne({ workspaceId: found.ws.id });
    if (!connection) return res.status(404).json({ error: "Search Console is not connected" });

    try {
      const accessToken = await usableSearchConsoleToken(String(connection._id));
      const sites = await listSearchConsoleSites(accessToken);
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

router.get(
  "/:wid/sites/:siteId/search-console/performance",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const found = await resolveSite(req);
    if (siteRefused(found)) return res.status(found.status).json({ error: found.error });
    if (!(await requirePaid(res, found.ws.id))) return;

    const siteId = String(found.site.get("siteId"));
    const link = await SearchConsoleProperty.findOne({ siteId });
    if (!link) return res.status(404).json({ error: "No Search Console property is linked to this site" });

    const connection = await SearchConsoleConnection.findOne({ workspaceId: found.ws.id });
    if (!connection) return res.status(404).json({ error: "Search Console is not connected" });

    try {
      const performance = await getSearchPerformance({
        workspaceId: found.ws.id,
        siteId,
        connectionId: String(connection._id),
        propertyUrl: String(link.get("propertyUrl")),
        days: clampRange(req.query.days),
        refresh: req.query.refresh === "1",
      });
      res.json(performance);
    } catch (err) {
      googleFailure(res, err);
    }
  }),
);

export default router;
