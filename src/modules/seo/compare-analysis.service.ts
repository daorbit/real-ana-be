import { Competitor } from "./models/Competitor.js";
import type { CompareSnapshot } from "./competitor.js";
import { compareSnapshots, computePosition, type CompetitorGap } from "./competitor-analysis.js";
import { loadBaseline } from "./compare-baseline.service.js";
import { readIssue, type ReadIssue } from "./snapshot-quality.js";

export type CompetitorEntry = {
  competitorId: string;
  label: string;
  url: string;
  lastCheckedAt: Date | null;
  lastError: string;
  lastErrorAt: Date | null;
  readIssue: ReadIssue | null;
  snapshot: CompareSnapshot;
  gap: CompetitorGap;
};

type CompetitorDoc = InstanceType<typeof Competitor>;

function toEntry(doc: CompetitorDoc, mine: CompareSnapshot): CompetitorEntry {
  const snapshot = doc.get("snapshot") as CompareSnapshot;
  return {
    competitorId: String(doc._id),
    label: doc.get("label") as string,
    url: doc.get("url") as string,
    lastCheckedAt: (doc.get("lastCheckedAt") as Date | null) ?? null,
    lastError: (doc.get("lastError") as string) ?? "",
    lastErrorAt: (doc.get("lastErrorAt") as Date | null) ?? null,
    readIssue: readIssue(snapshot),
    snapshot,
    gap: compareSnapshots(mine, snapshot),
  };
}

export async function competitorAnalysis(siteId: string, limit?: number) {
  const query = Competitor.find({ siteId }).sort({ createdAt: 1 });
  const [baseline, docs] = await Promise.all([loadBaseline(siteId), limit ? query.limit(limit) : query]);
  if (!baseline) return null;

  const mine = baseline.snapshot;
  const competitors = docs.filter((d) => d.get("snapshot")).map((d) => toEntry(d, mine));
  const comparable = competitors.filter((c) => !c.readIssue);

  return {
    mine,
    baseline: {
      source: baseline.source,
      checkedAt: baseline.checkedAt,
      lastError: baseline.lastError,
      readIssue: readIssue(mine),
    },
    auditedAt: baseline.checkedAt,
    competitors,
    toughest: [...comparable].sort((a, b) => b.gap.scoreGap - a.gap.scoreGap)[0]?.competitorId ?? null,
    position: computePosition(mine.score, comparable),
  };
}

export type CompetitorAnalysis = NonNullable<Awaited<ReturnType<typeof competitorAnalysis>>>;
