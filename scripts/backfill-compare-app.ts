import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Competitor } from "../src/modules/seo/models/Competitor.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const workspaceIds = await Competitor.distinct("workspaceId");
  const pending = await Workspace.countDocuments({ _id: { $in: workspaceIds }, "apps.compare.enabled": { $ne: true } });

  console.log(`${workspaceIds.length} workspace(s) track competitors; ${pending} still have Compare off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(
      { _id: { $in: workspaceIds }, "apps.compare.enabled": { $ne: true } },
      { $set: { "apps.compare.enabled": true, "apps.compare.enabledAt": new Date() } },
    );
    console.log(`Turned Quantalog Compare on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
