import { Site } from "./models/Site.js";
import { Event } from "./models/Event.js";

type SiteDoc = InstanceType<typeof Site>;

export async function fillMissingFirstEvents(sites: SiteDoc[]): Promise<void> {
  const pending = sites.filter((site) => !site.get("firstEventAt"));
  if (!pending.length) return;

  const firsts = await Promise.all(
    pending.map((site) => Event.findOne({ siteId: site.get("siteId") }).sort({ ts: 1 }).select("ts").lean()),
  );

  const found = pending
    .map((site, i) => ({ site, ts: firsts[i]?.ts as Date | undefined }))
    .filter((entry): entry is { site: SiteDoc; ts: Date } => Boolean(entry.ts));
  if (!found.length) return;

  for (const { site, ts } of found) site.set("firstEventAt", ts);
  await Site.bulkWrite(
    found.map(({ site, ts }) => ({
      updateOne: { filter: { _id: site._id, firstEventAt: null }, update: { $set: { firstEventAt: ts } } },
    })),
  );
}
