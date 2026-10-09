import { Competitor } from "./models/Competitor.js";
import { CompetitorSnapshot } from "./models/CompetitorSnapshot.js";
import { snapshotPage, type CompareSnapshot } from "./competitor.js";

const MAX_HISTORY = 60;

type CompetitorDoc = InstanceType<typeof Competitor>;

export async function recordSnapshot(
  competitorId: string,
  siteId: string,
  snapshot: CompareSnapshot
): Promise<void> {
  try {
    await CompetitorSnapshot.create({
      competitorId,
      siteId,
      score: snapshot.score,
      wordCount: snapshot.wordCount,
      responseTimeMs: snapshot.responseTimeMs,
      pageBytes: snapshot.pageBytes,
      internalLinks: snapshot.internalLinks,
      schemaErrors: snapshot.schemaErrors,
      statusCode: snapshot.statusCode,
    });

    const stale = await CompetitorSnapshot.find({ competitorId })
      .sort({ takenAt: -1 })
      .skip(MAX_HISTORY)
      .select("_id");
    if (stale.length) {
      await CompetitorSnapshot.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
    }
  } catch {
    return;
  }
}

export async function refetchCompetitor(competitor: CompetitorDoc, siteId: string): Promise<void> {
  try {
    const snapshot = await snapshotPage(competitor.get("url") as string);
    competitor.set({ snapshot, lastCheckedAt: new Date(), lastError: "", lastErrorAt: null });
    await competitor.save();
    await recordSnapshot(String(competitor._id), siteId, snapshot);
  } catch (e) {
    competitor.set({
      lastError: (e as Error)?.message ?? "could not fetch that URL",
      lastErrorAt: new Date(),
    });
    await competitor.save();
    throw e;
  }
}
