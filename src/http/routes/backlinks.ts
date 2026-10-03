import { Router, Response } from "express";
import { requireAuth, blockDemoWrites, AuthedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { resolveSite, siteRefused, type SiteResult } from "./resolve-site.js";
import { normalizeUrl, urlMatchesDomain } from "../../modules/seo/seo.service.js";
import { rateLimit, BlockedUrlError } from "../../infra/http-client/safe-fetch.js";
import { backlinkIndexConfigured } from "../../infra/http-client/backlink-index.js";
import { Backlink } from "../../modules/backlinks/models/Backlink.js";
import { cleanSourceUrl } from "../../modules/backlinks/domains.js";
import {
  siteRef, addBacklink, discoverAndVerify, recheckSite, verifyBacklink, trackedCompetitors,
} from "../../modules/backlinks/backlinks.service.js";
import { checkPage, syncFromIndex, listCompetitorLinks } from "../../modules/backlinks/competitor-links.service.js";
import { buildOverview } from "../../modules/backlinks/backlinks-overview.js";

const router = Router();
router.use(requireAuth);
router.use(blockDemoWrites);

const BASE = "/:wid/sites/:siteId/backlinks";
const MAX_BACKLINKS = 1000;

function fetchBudget(workspaceId: string) {
  return rateLimit(`backlinks:${workspaceId}`, { capacity: 20, refillPerMinute: 6 });
}

function indexBudget(workspaceId: string) {
  return rateLimit(`backlink-index:${workspaceId}`, { capacity: 3, refillPerMinute: 0.05 });
}

function throttled(res: Response, retryAfterMs: number) {
  return res.status(429).json({ error: `too many checks — try again in ${Math.ceil(retryAfterMs / 1000)}s` });
}

async function editableSite(req: AuthedRequest, res: Response) {
  const found: SiteResult = await resolveSite(req, "editor");
  if (siteRefused(found)) {
    res.status(found.status).json({ error: found.error });
    return null;
  }
  if (!found.site.domain) {
    res.status(400).json({ error: "backlinks need a web site with a domain" });
    return null;
  }
  const budget = fetchBudget(found.ws.id);
  if (!budget.allowed) {
    throttled(res, budget.retryAfterMs);
    return null;
  }
  return { ...found, ref: siteRef(found.site, found.ws.id) };
}

function readUrl(req: AuthedRequest, domain: string, res: Response): string | null {
  const normalized = normalizeUrl(String(req.body?.url ?? ""));
  const url = normalized ? cleanSourceUrl(normalized) : null;
  if (!url) {
    res.status(400).json({ error: "invalid URL" });
    return null;
  }
  if (urlMatchesDomain(url, domain)) {
    res.status(400).json({ error: "that page is on your own site" });
    return null;
  }
  return url;
}

function fetchFailed(res: Response, url: string, e: unknown) {
  const message = (e as Error)?.message ?? "could not fetch that page";
  if (e instanceof BlockedUrlError) return res.status(400).json({ error: `cannot check ${url}: ${message}` });
  return res.status(502).json({ error: `could not fetch ${url}: ${message}` });
}

router.get(BASE, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const found = await resolveSite(req);
  if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

  const list = await Backlink.find({ siteId: found.site.siteId })
    .sort({ lastLiveAt: -1, referralVisits: -1, createdAt: -1 })
    .limit(MAX_BACKLINKS)
    .lean();
  res.json(list);
}));

router.get(`${BASE}/overview`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const found = await resolveSite(req);
  if (siteRefused(found)) return res.status(found.status).json({ error: found.error });
  res.json(await buildOverview(siteRef(found.site, found.ws.id)));
}));

router.get(`${BASE}/competitors/:competitorId`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const found = await resolveSite(req);
  if (siteRefused(found)) return res.status(found.status).json({ error: found.error });
  res.json(await listCompetitorLinks(found.site.siteId, String(req.params.competitorId)));
}));

router.post(`${BASE}/discover`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const ctx = await editableSite(req, res);
  if (!ctx) return;
  res.json(await discoverAndVerify(ctx.ref));
}));

router.post(`${BASE}/recheck`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const ctx = await editableSite(req, res);
  if (!ctx) return;
  res.json(await recheckSite(ctx.ref));
}));

router.post(`${BASE}/check-page`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const ctx = await editableSite(req, res);
  if (!ctx) return;
  const url = readUrl(req, ctx.ref.domain, res);
  if (!url) return;

  try {
    res.json(await checkPage(ctx.ref, url));
  } catch (e) {
    fetchFailed(res, url, e);
  }
}));

router.post(`${BASE}/index-sync`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  if (!backlinkIndexConfigured())
    return res.status(501).json({ error: "no backlink index is configured on this server" });

  const found = await resolveSite(req, "editor");
  if (siteRefused(found)) return res.status(found.status).json({ error: found.error });
  if (!found.site.domain) return res.status(400).json({ error: "backlinks need a web site with a domain" });

  const budget = indexBudget(found.ws.id);
  if (!budget.allowed) return throttled(res, budget.retryAfterMs);

  try {
    res.json(await syncFromIndex(siteRef(found.site, found.ws.id)));
  } catch (e) {
    res.status(502).json({ error: (e as Error)?.message ?? "backlink index request failed" });
  }
}));

router.post(BASE, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const ctx = await editableSite(req, res);
  if (!ctx) return;
  const url = readUrl(req, ctx.ref.domain, res);
  if (!url) return;

  const count = await Backlink.countDocuments({ siteId: ctx.ref.siteId });
  if (count >= MAX_BACKLINKS) return res.status(400).json({ error: `at most ${MAX_BACKLINKS} backlinks per site` });

  try {
    res.status(201).json(await addBacklink(ctx.ref, url));
  } catch (e) {
    fetchFailed(res, url, e);
  }
}));

router.post(`${BASE}/:id/recheck`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const ctx = await editableSite(req, res);
  if (!ctx) return;

  const doc = await Backlink.findOne({ _id: req.params.id, siteId: ctx.ref.siteId });
  if (!doc) return res.status(404).json({ error: "backlink not found" });

  await verifyBacklink(doc, ctx.ref, await trackedCompetitors(ctx.ref.siteId));
  res.json(doc);
}));

router.delete(`${BASE}/:id`, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const found = await resolveSite(req, "editor");
  if (siteRefused(found)) return res.status(found.status).json({ error: found.error });

  const deleted = await Backlink.findOneAndDelete({ _id: req.params.id, siteId: found.site.siteId });
  if (!deleted) return res.status(404).json({ error: "backlink not found" });
  res.status(204).end();
}));

export default router;
