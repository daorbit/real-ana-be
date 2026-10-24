import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/infra/db/connection.js";
import { Funnel } from "../src/modules/analytics/models/Funnel.js";
import { Workspace } from "../src/modules/workspace/models/Workspace.js";

const WRITE = process.argv.includes("--write");

async function main() {
  await connectDB();

  const workspaceIds = await Funnel.distinct("workspaceId");
  const pending = await Workspace.countDocuments({ _id: { $in: workspaceIds }, "apps.funnels.enabled": { $ne: true } });

  console.log(`${workspaceIds.length} workspace(s) have saved funnels; ${pending} still have Funnels off.`);

  if (WRITE && pending) {
    const result = await Workspace.updateMany(
      { _id: { $in: workspaceIds }, "apps.funnels.enabled": { $ne: true } },
      { $set: { "apps.funnels.enabled": true, "apps.funnels.enabledAt": new Date() } },
    );
    console.log(`Turned Quantalog Funnels on for ${result.modifiedCount} workspace(s).`);
  }

  if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
