import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { SocialConnection } from "../src/modules/identity/models/SocialConnection.js";
import { ScheduledPost } from "../src/modules/social/models/ScheduledPost.js";
import { Membership } from "../src/modules/workspace/models/Membership.js";

const WRITE = process.argv.includes("--write");
const LEGACY_INDEX = "userId_1_provider_1";

async function targetWorkspaces(userId: Types.ObjectId, provider: string): Promise<string[]> {
  const scheduled = (await ScheduledPost.distinct("workspaceId", { userId, provider })).map(String);
  if (scheduled.length) return scheduled;
  const owned = await Membership.findOne({ userId, role: "owner" }).sort({ createdAt: 1 }).select("workspaceId").lean();
  return owned ? [String(owned.workspaceId)] : [];
}

async function main() {
  await connectDB();
  const collection = SocialConnection.collection;

  const indexes = await collection.indexes();
  if (indexes.some((i) => i.name === LEGACY_INDEX)) {
    console.log(`Legacy unique index ${LEGACY_INDEX} found.`);
    if (WRITE) await collection.dropIndex(LEGACY_INDEX);
  }

  const legacy = await collection.find({ workspaceId: { $exists: false } }).toArray();
  console.log(`${legacy.length} user-level connection(s) to move.`);

  let created = 0;
  let orphaned = 0;
  for (const row of legacy) {
    const targets = await targetWorkspaces(row.userId, row.provider);
    if (!targets.length) orphaned++;

    for (const workspaceId of targets) {
      const wid = new Types.ObjectId(workspaceId);
      const exists = await collection.findOne({ workspaceId: wid, provider: row.provider });
      if (exists) continue;
      created++;
      if (WRITE) {
        const { _id, ...rest } = row;
        await collection.insertOne({ ...rest, workspaceId: wid });
      }
    }
    if (WRITE) await collection.deleteOne({ _id: row._id });
  }

  console.log(`${created} workspace connection(s) ${WRITE ? "created" : "would be created"}; ${orphaned} with no workspace dropped.`);

  if (WRITE) await SocialConnection.syncIndexes();
  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
