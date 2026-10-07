import { Types } from "mongoose";
import { pooled } from "../../infra/http-client/safe-fetch.js";
import { Site } from "../analytics/models/Site.js";
import { Competitor } from "../seo/models/Competitor.js";
import { Backlink, type BacklinkStatus } from "./models/Backlink.js";
import { CompetitorBacklink } from "./models/CompetitorBacklink.js";
import { discoverReferrals } from "./discover.js";
import { checkSource, nextStatus, type TrackedDomain, type VerifyOutcome } from "./verify.js";
import { bareDomain, hostOf } from "./domains.js";

export type SiteRef = { siteId: string; domain: string; workspaceId: string };
export type TrackedCompetitor = TrackedDomain & { label: string };
export type BacklinkDoc = NonNullable<Awaited<ReturnType<typeof Backlink.findOne>>>;

export const MAX_VERIFY_PER_RUN = 20;
const VERIFY_CONCURRENCY = 4;
const RECHECK_AFTER_DAYS = 7;
const CRON_BATCH = 60;

export function siteRef(site: { siteId: string; domain: string }, workspaceId: string): SiteRef {
  return { siteId: site.siteId, domain: bareDomain(site.domain), workspaceId };
}

export async function trackedCompetitors(siteId: string): Promise<TrackedCompetitor[]> {
  const list = await Competitor.find({ siteId }).sort({ createdAt: 1 }).select("_id url label").lean();
  return list
    .map((c) => {
      const domain = hostOf(String(c.url)) ?? "";
      return { competitorId: String(c._id), domain, label: String(c.label || domain) };
    })
    .filter((c) => c.domain);
}

export async function recordCompetitorLinks(
  site: SiteRef,
  sourceUrl: string,
  outcome: VerifyOutcome,
  competitors: TrackedDomain[]
): Promise<void> {
  if (outcome.httpStatus === null || outcome.httpStatus >= 400 || competitors.length === 0) return;

  const now = new Date();
  const sourceDomain = hostOf(sourceUrl) ?? "";
  const foundIds = new Set(outcome.competitorLinks.map((l) => l.competitorId));
  const missing = competitors.map((c) => c.competitorId).filter((id) => !foundIds.has(id));

  const ops: Parameters<typeof CompetitorBacklink.bulkWrite>[0] = outcome.competitorLinks.map(({ competitorId, link }) => ({
    updateOne: {
      filter: { competitorId, sourceUrl },
      update: {
        $set: { ...link, sourceDomain, status: "live", lastSeenAt: now },
        $setOnInsert: { workspaceId: site.workspaceId, siteId: site.siteId, origin: "scan" },
      },
      upsert: true,
    },
  }));
  if (missing.length) {
    ops.push({
      updateMany: {
        filter: { competitorId: { $in: missing }, sourceUrl, origin: "scan", status: "live" },
        update: { $set: { status: "lost" } },
      },
    });
  }
  if (ops.length) await CompetitorBacklink.bulkWrite(ops);
}

export async function verifyBacklink(
  doc: BacklinkDoc,
  site: SiteRef,
  competitors: TrackedDomain[]
): Promise<VerifyOutcome> {
  const outcome = await checkSource(doc.sourceUrl, site.domain, competitors);
  const next = nextStatus(
    {
      status: doc.status as BacklinkStatus,
      lastLiveAt: doc.lastLiveAt ?? null,
      lostAt: doc.lostAt ?? null,
    },
    outcome
  );

  doc.set({
    ...next,
    ...(outcome.found ?? {}),
    httpStatus: outcome.httpStatus,
    lastCheckedAt: new Date(),
    lastError: outcome.error,
  });
  await doc.save();
  await recordCompetitorLinks(site, doc.sourceUrl, outcome, competitors);
  return outcome;
}

export async function verifyMany(site: SiteRef, docs: BacklinkDoc[]) {
  const competitors = await trackedCompetitors(site.siteId);
  const outcomes = await pooled(docs, VERIFY_CONCURRENCY, (doc) =>
    verifyBacklink(doc, site, competitors).catch(() => null)
  );
  return {
    checked: docs.length,
    live: docs.filter((d) => d.status === "live").length,
    lost: docs.filter((d) => d.status === "lost" || d.status === "page-gone").length,
    failed: outcomes.filter((o) => o === null).length,
  };
}

export async function syncReferrals(site: SiteRef) {
  const sources = await discoverReferrals(site.siteId, site.domain);
  if (sources.length === 0) return { discovered: 0, added: 0 };

  const result = await Backlink.bulkWrite(
    sources.map((s) => ({
      updateOne: {
        filter: { siteId: site.siteId, sourceUrl: s.sourceUrl },
        update: {
          $set: { sourceDomain: s.sourceDomain, referralVisits: s.visits, lastReferralAt: s.lastAt },
          $setOnInsert: {
            workspaceId: new Types.ObjectId(site.workspaceId),
            origin: "referral",
            status: "pending",
            targetUrl: `https://${site.domain}${s.landingPath}`,
          },
        },
        upsert: true,
      },
    }))
  );
  return { discovered: sources.length, added: result.upsertedCount };
}

export async function discoverAndVerify(site: SiteRef) {
  const sync = await syncReferrals(site);
  const pending = await Backlink.find({ siteId: site.siteId, status: "pending" })
    .sort({ referralVisits: -1 })
    .limit(MAX_VERIFY_PER_RUN);
  const verified = await verifyMany(site, pending);
  const remaining = await Backlink.countDocuments({ siteId: site.siteId, status: "pending" });
  return { ...sync, verified, remaining };
}

export async function addBacklink(site: SiteRef, sourceUrl: string): Promise<BacklinkDoc> {
  const doc = await Backlink.findOneAndUpdate(
    { siteId: site.siteId, sourceUrl },
    {
      $setOnInsert: {
        workspaceId: site.workspaceId,
        siteId: site.siteId,
        sourceUrl,
        sourceDomain: hostOf(sourceUrl) ?? "",
        origin: "manual",
        status: "pending",
      },
    },
    { upsert: true, new: true }
  );
  if (!doc) throw new Error("could not save backlink");
  await verifyBacklink(doc, site, await trackedCompetitors(site.siteId));
  return doc;
}

export async function recheckSite(site: SiteRef) {
  const docs = await Backlink.find({ siteId: site.siteId })
    .sort({ lastCheckedAt: 1 })
    .limit(MAX_VERIFY_PER_RUN);
  const result = await verifyMany(site, docs);
  const total = await Backlink.countDocuments({ siteId: site.siteId });
  return { ...result, remaining: Math.max(0, total - docs.length) };
}

export async function recheckDue() {
  const cutoff = new Date(Date.now() - RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const due = await Backlink.find({ $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: cutoff } }] })
    .sort({ lastCheckedAt: 1 })
    .limit(CRON_BATCH);

  const bySite = new Map<string, BacklinkDoc[]>();
  for (const doc of due) {
    const list = bySite.get(doc.siteId) ?? [];
    list.push(doc);
    bySite.set(doc.siteId, list);
  }

  let checked = 0;
  let lost = 0;
  for (const [siteId, docs] of bySite) {
    const site = await Site.findOne({ siteId }).select("siteId domain workspaceId").lean();
    if (!site?.domain) continue;
    const result = await verifyMany(siteRef(site, String(site.workspaceId)), docs);
    checked += result.checked;
    lost += result.lost;
  }
  return { sites: bySite.size, checked, lost };
}
