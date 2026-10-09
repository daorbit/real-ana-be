import { CompareBaseline } from "./models/CompareBaseline.js";
import { SeoReport } from "./models/SeoReport.js";
import { normalizeUrl } from "./seo.service.js";
import { snapshotFromReport, snapshotPage, type CompareSnapshot } from "./competitor.js";
import { readIssue } from "./snapshot-quality.js";

const MAX_HISTORY = 60;

export type BaselineSource = "live" | "audit";

export type Baseline = {
  snapshot: CompareSnapshot;
  source: BaselineSource;
  checkedAt: Date | null;
  lastError: string;
};

type ReportData = Parameters<typeof snapshotFromReport>[0];

async function baselineUrl(siteId: string, domain: string): Promise<string | null> {
  const report = await SeoReport.findOne({ siteId }).sort({ createdAt: -1 }).select("url").lean();
  return (report?.url as string | undefined) || normalizeUrl(domain);
}

export async function refreshBaseline(site: { siteId: string; domain: string }): Promise<void> {
  const url = await baselineUrl(site.siteId, site.domain);
  if (!url) return;

  try {
    const snapshot = await snapshotPage(url);
    await CompareBaseline.updateOne(
      { siteId: site.siteId },
      {
        $set: { url, snapshot, checkedAt: new Date(), lastError: "", lastErrorAt: null },
        $push: {
          history: {
            $each: [{
              score: snapshot.score,
              wordCount: snapshot.wordCount,
              responseTimeMs: snapshot.responseTimeMs,
              statusCode: snapshot.statusCode,
              takenAt: new Date(),
            }],
            $slice: -MAX_HISTORY,
          },
        },
      },
      { upsert: true }
    );
  } catch (e) {
    await CompareBaseline.updateOne(
      { siteId: site.siteId },
      {
        $set: { url, lastError: (e as Error)?.message ?? "could not fetch your page", lastErrorAt: new Date() },
      },
      { upsert: true }
    );
  }
}

export async function loadBaseline(siteId: string): Promise<Baseline | null> {
  const live = await CompareBaseline.findOne({ siteId }).select("snapshot checkedAt lastError").lean();
  const liveBaseline: Baseline | null = live?.snapshot
    ? {
        snapshot: live.snapshot as CompareSnapshot,
        source: "live",
        checkedAt: (live.checkedAt as Date | null) ?? null,
        lastError: (live.lastError as string) ?? "",
      }
    : null;

  if (liveBaseline && !readIssue(liveBaseline.snapshot)) return liveBaseline;

  const report = await SeoReport.findOne({ siteId }).sort({ createdAt: -1 }).select("data createdAt").lean();
  if (report?.data) {
    return {
      snapshot: snapshotFromReport(report.data as ReportData),
      source: "audit",
      checkedAt: (report.createdAt as Date | undefined) ?? null,
      lastError: (live?.lastError as string) ?? "",
    };
  }

  return liveBaseline;
}

export async function baselineHistory(siteId: string) {
  const doc = await CompareBaseline.findOne({ siteId }).select("history").lean();
  return (doc?.history ?? []) as {
    score: number;
    wordCount: number;
    responseTimeMs: number;
    statusCode: number;
    takenAt: Date;
  }[];
}
