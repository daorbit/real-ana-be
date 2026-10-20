import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Site } from "../src/modules/analytics/models/Site.js";
import { Event } from "../src/modules/analytics/models/Event.js";

const WRITE = process.argv.includes("--write");
const BATCH = 20;

async function firstEvent(siteId: string) {
  const first = await Event.findOne({ siteId }).sort({ ts: 1 }).select("ts").lean();
  return first?.ts ?? null;
}

async function main() {
  await connectDB();

  const sites = await Site.find({ firstEventAt: null }).select("siteId").lean();
  console.log(`${sites.length} site(s) have no firstEventAt yet.`);

  let found = 0;
  let written = 0;
  for (let i = 0; i < sites.length; i += BATCH) {
    const batch = sites.slice(i, i + BATCH);
    const firsts = await Promise.all(batch.map((s) => firstEvent(String(s.siteId))));
    const updates = batch
      .map((s, j) => ({ siteId: String(s.siteId), ts: firsts[j] }))
      .filter((u): u is { siteId: string; ts: Date } => u.ts !== null);
    found += updates.length;
    if (WRITE && updates.length) {
      const result = await Site.bulkWrite(
        updates.map((u) => ({
          updateOne: { filter: { siteId: u.siteId, firstEventAt: null }, update: { $set: { firstEventAt: u.ts } } },
        })),
      );
      written += result.modifiedCount;
    }
  }

  console.log(`${found} of them have already sent events.`);
  if (WRITE) console.log(`Set firstEventAt on ${written} site(s).`);
  else console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
